import { ICONS, PAGE_1_DEFAULT, PAGE_2_DEFAULT, type DesktopIconId, type IconId, type IconPosition } from "@/lib/desktop-config";
import { isCustomAppIconId } from "@/lib/custom-app-types";
import { loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZE_CELLS, type WidgetInstance } from "@/lib/widget-types";
import { kvSet, registerKvMigration } from "./kv-db";

export const ICON_LAYOUT_STORAGE_KEY = "ai_phone_icon_layout_v2";
export const ICON_LAYOUT_STORAGE_KEY_V1 = "ai_phone_icon_layout_v1";

registerKvMigration(ICON_LAYOUT_STORAGE_KEY);
registerKvMigration(ICON_LAYOUT_STORAGE_KEY_V1);

export type DesktopPageKey = `page${number}`;

export type DesktopIconLayout = Record<DesktopPageKey, IconPosition[]> & {
  page1: IconPosition[];
  page2: IconPosition[];
};

export function getDesktopPageKey(pageNumber: number): DesktopPageKey {
  const safePage = Math.max(1, Math.floor(pageNumber));
  return `page${safePage}` as DesktopPageKey;
}

export function getDesktopPageNumber(pageKey: string): number {
  const match = pageKey.match(/^page([1-9]\d*)$/);
  return match ? Number(match[1]) : 0;
}

export function getDesktopPageKeys(layout: Partial<Record<string, unknown>>): DesktopPageKey[] {
  const maxPage = Math.max(
    2,
    ...Object.keys(layout)
      .map(getDesktopPageNumber)
      .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1)
  );
  return Array.from({ length: maxPage }, (_, index) => getDesktopPageKey(index + 1));
}

export function getDesktopIconLayoutItems(layout: DesktopIconLayout): IconPosition[] {
  return getDesktopPageKeys(layout).flatMap((pageKey) => layout[pageKey] ?? []);
}

function getInstalledCustomIconIds(): Set<string> {
  return new Set(loadInstalledCustomApps().map(app => `custom_app:${app.id}`));
}

function migrateLegacyDesktopIconId(id: string, customIconIds = getInstalledCustomIconIds()): DesktopIconId | null {
  if (id === "forum") return "cocreate";
  if (id === "fortune") return "interview_magazine";
  if (isCustomAppIconId(id) && customIconIds.has(id)) return id;
  return id in ICONS ? id as IconId : null;
}

function buildWidgetOccupancy(widgets: WidgetInstance[], page: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => false)
  );

  for (const widget of widgets) {
    if (widget.page !== page) continue;
    const [rows, cols] = WIDGET_SIZE_CELLS[widget.size];
    for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
      for (let colOffset = 0; colOffset < cols; colOffset++) {
        const row = widget.row - 1 + rowOffset;
        const col = widget.col - 1 + colOffset;
        if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS) {
          grid[row][col] = true;
        }
      }
    }
  }

  return grid;
}

function flowIconsToPositions(icons: DesktopIconId[], occupied?: boolean[][]): IconPosition[] {
  const result: IconPosition[] = [];
  let index = 0;
  for (let row = 0; row < GRID_ROWS && index < icons.length; row++) {
    for (let col = 0; col < GRID_COLS && index < icons.length; col++) {
      if (occupied?.[row]?.[col]) {
        continue;
      }
      result.push({ id: icons[index], row: row + 1, col: col + 1 });
      index++;
    }
  }
  return result;
}

export function createDefaultDesktopIconLayout(_widgets: WidgetInstance[] = []): DesktopIconLayout {
  return {
    page1: PAGE_1_DEFAULT.map((id, i) => ({
      id,
      row: 5 + Math.floor(i / GRID_COLS),
      col: (i % GRID_COLS) + 1,
    })),
    page2: PAGE_2_DEFAULT.map((id, i) => ({
      id,
      row: 4 + Math.floor(i / GRID_COLS),
      col: (i % GRID_COLS) + 1,
    })),
  } as DesktopIconLayout;
}

function normalizePage(raw: unknown): IconPosition[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const knownIcons = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seenIds = new Set<DesktopIconId>();
  const seenCells = new Set<string>();
  const result: IconPosition[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const { id, row, col } = item as { id?: unknown; row?: unknown; col?: unknown };
    if (typeof id !== "string" || typeof row !== "number" || typeof col !== "number") {
      continue;
    }
    const migratedId = migrateLegacyDesktopIconId(id, customIconIds);
    if (
      !migratedId
      || (!knownIcons.has(migratedId) && !customIconIds.has(migratedId))
      || row < 1
      || row > GRID_ROWS
      || col < 1
      || col > GRID_COLS
    ) {
      continue;
    }

    const iconId = migratedId;
    const cellKey = `${row},${col}`;
    if (seenIds.has(iconId) || seenCells.has(cellKey)) {
      continue;
    }

    seenIds.add(iconId);
    seenCells.add(cellKey);
    result.push({ id: iconId, row, col });
  }

  return result;
}

export function normalizeDesktopIconLayout(raw: unknown): DesktopIconLayout {
  if (!raw || typeof raw !== "object") {
    return createDefaultDesktopIconLayout();
  }

  const candidate = raw as Record<string, unknown>;
  const normalized = {} as DesktopIconLayout;
  for (const pageKey of getDesktopPageKeys(candidate)) {
    normalized[pageKey] = normalizePage(candidate[pageKey]);
  }
  return normalized;
}

export function writeDesktopIconLayout(layout: DesktopIconLayout): DesktopIconLayout {
  const normalized = normalizeDesktopIconLayout(layout);
  kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

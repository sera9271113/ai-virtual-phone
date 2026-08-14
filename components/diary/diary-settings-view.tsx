import { ChevronLeft } from "lucide-react";
import type { Character } from "@/lib/character-types";
import type { DiaryEntryTimerSettings } from "@/lib/diary-entry-types";
import { CharacterAvatarGrid } from "./diary-character-avatar-grid";

type DiarySettingsViewProps = {
  onBack: () => void;
  // Font size props
  diaryFontScale: number;
  onScaleChange: (scale: number) => void;
  onResetFont: () => void;
  // Timer props
  characters: Character[];
  settings: DiaryEntryTimerSettings;
  generatingCharacterIds: string[];
  onTimerSettingsChange: (settings: DiaryEntryTimerSettings) => void;
};

export function DiarySettingsView({
  onBack,
  diaryFontScale,
  onScaleChange,
  onResetFont,
  characters,
  settings,
  generatingCharacterIds,
  onTimerSettingsChange
}: DiarySettingsViewProps) {
  return (
    <div className="diary-settings-view">
      <header className="diary-app-header">
        <button type="button" className="diary-icon-btn" onClick={onBack} aria-label="返回">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>设置</h1>
        </div>
        <div className="diary-header-spacer" />
      </header>
      <main className="diary-settings-main">
        {/* We can inline the font and timer panels here, adapting their styles to not be modals */}
        <section className="diary-settings-section">
          <header>
            <h2>日记字号</h2>
            <p>调整日记正文的显示大小</p>
          </header>
          <label className="diary-font-size-control">
            <span>
              <strong>字号</strong>
              <em>{Math.round(diaryFontScale * 100)}%</em>
            </span>
            <input
              type="range"
              min="0.85"
              max="1.25"
              step="any"
              value={diaryFontScale}
              onChange={event => onScaleChange(Number(event.target.value))}
            />
          </label>
          <button type="button" className="diary-font-reset-btn" onClick={onResetFont}>
            恢复默认
          </button>
        </section>

        <section className="diary-settings-section">
          <header>
            <h2>定时写日记</h2>
          </header>
          <div className="diary-entry-setting-grid">
            <div className="diary-entry-toggle-row">
              <span>定时写日记</span>
              <span className="diary-entry-toggle-row-controls">
                <label className="diary-entry-interval-inline">
                  <span>间隔小时</span>
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={settings.intervalHours}
                    onChange={event => onTimerSettingsChange({ ...settings, intervalHours: Math.max(1, Math.min(720, Number(event.target.value) || 24)) })}
                  />
                </label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={event => onTimerSettingsChange({ ...settings, enabled: event.target.checked })}
                />
              </span>
            </div>
          </div>

          <div className="diary-entry-character-section">
            <div className="diary-entry-section-title">
              <strong>定时角色</strong>
              <span>{settings.characterIds.length ? `已选 ${settings.characterIds.length} 个` : "默认全部"}</span>
            </div>
            <CharacterAvatarGrid
              characters={characters}
              selectedIds={settings.characterIds}
              busyIds={[]}
              disabled={false}
              onToggle={characterId => onTimerSettingsChange({
                ...settings,
                characterIds: settings.characterIds.includes(characterId)
                  ? settings.characterIds.filter(id => id !== characterId)
                  : [...settings.characterIds, characterId],
              })}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

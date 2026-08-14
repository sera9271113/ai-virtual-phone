import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DiaryEntry } from "@/lib/diary-entry-types";

type DiaryDateStripProps = {
  entries: DiaryEntry[];
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
};

function isSameDay(d1: Date, d2: Date) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

export function DiaryDateStrip({ entries, selectedDate, onSelectDate }: DiaryDateStripProps) {
  // weekOffset counts whole weeks back from the current week (0 = this week,
  // 1 = last week, 2 = two weeks ago, ...). Lets the strip page back through
  // any past week (7, 14, 21... days) while always showing exactly 7
  // same-size squares — no inner scrolling.
  const [weekOffset, setWeekOffset] = useState(0);

  const currentWeekStart = useMemo(() => startOfWeek(new Date()), []);

  const weekStart = useMemo(() => {
    const start = new Date(currentWeekStart);
    start.setDate(start.getDate() - weekOffset * 7);
    return start;
  }, [currentWeekStart, weekOffset]);

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const entryDates = useMemo(() => {
    return entries.map(e => new Date(e.createdAt));
  }, [entries]);

  const rangeLabel = useMemo(() => {
    const first = days[0];
    const last = days[6];
    const fmt = (d: Date) => `${d.getMonth() + 1}.${d.getDate()}`;
    return `${fmt(first)}-${fmt(last)}`;
  }, [days]);

  const canGoNext = weekOffset > 0;

  return (
    <div className="diary-date-strip-wrap">
      <div className="diary-date-strip-header">
        <button
          type="button"
          className="diary-date-nav-btn"
          aria-label="上一周"
          onClick={() => setWeekOffset(offset => offset + 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="diary-date-range-label">{rangeLabel}</span>
        <button
          type="button"
          className="diary-date-nav-btn"
          aria-label="下一周"
          disabled={!canGoNext}
          onClick={() => setWeekOffset(offset => Math.max(0, offset - 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="diary-date-strip">
        {days.map((day, i) => {
          const hasEntry = entryDates.some(ed => isSameDay(ed, day));
          const isSelected = isSameDay(day, selectedDate);
          const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
          return (
            <button
              key={i}
              type="button"
              className={`diary-date-item ${isSelected ? 'is-selected' : ''} ${hasEntry ? 'has-entry' : ''}`}
              onClick={() => onSelectDate(day)}
            >
              <span className="diary-date-weekday">{dayNames[day.getDay()]}</span>
              <strong className="diary-date-number">{day.getDate()}</strong>
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { Bot } from "lucide-react";
import type { Character } from "@/lib/character-types";

export function DiaryWritingStatus({ label = "写入中" }: { label?: string }) {
  return (
    <span className="diary-writing-status" aria-label={label}>
      <span>{label}</span>
      <span className="diary-writing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function CharacterAvatarGrid({ characters, selectedIds, busyIds, disabled, onToggle }: {
  characters: Character[];
  selectedIds: string[];
  busyIds: string[];
  // Applies to every button regardless of that character's own state — use
  // this only for whole-panel states like "my own submission is in flight",
  // not for "someone else happens to be generating". Per-character busy-ness
  // is handled separately below via busyIds so an unrelated background
  // generation (e.g. the timer writing for another character) doesn't lock
  // out characters that are actually free to pick.
  disabled: boolean;
  onToggle: (characterId: string) => void;
}) {
  if (characters.length === 0) return <p className="diary-entry-empty-line">暂无角色。</p>;

  return (
    <div className="diary-entry-character-grid">
      {characters.map(character => {
        const selected = selectedIds.includes(character.id);
        const busy = busyIds.includes(character.id);
        return (
          <button
            key={character.id}
            type="button"
            className={selected ? "is-selected" : ""}
            disabled={disabled || busy}
            aria-pressed={selected}
            onClick={() => onToggle(character.id)}
          >
            <span className="diary-entry-character-avatar">
              {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={24} />}
            </span>
            <strong>{character.name}</strong>
            {busy ? <em><DiaryWritingStatus /></em> : null}
          </button>
        );
      })}
    </div>
  );
}

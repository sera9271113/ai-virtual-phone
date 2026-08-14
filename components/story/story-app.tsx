
"use client";

import { useState } from "react";
import { StoryCharacterSelect } from "./story-character-select";
import { StoryAppBase } from "./story-app-base";

type StoryAppProps = {
  onClose: () => void;
};

export function StoryApp({ onClose }: StoryAppProps) {
  const [characterId, setCharacterId] = useState<string | null>(null);

  if (!characterId) {
    return <StoryCharacterSelect onSelect={setCharacterId} onClose={onClose} />;
  }

  return (
    <StoryAppBase
      key={characterId}
      characterId={characterId}
      onBack={() => setCharacterId(null)}
      onClose={onClose}
    />
  );
}

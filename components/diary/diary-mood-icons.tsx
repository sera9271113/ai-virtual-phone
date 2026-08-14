import type { MoodId } from "@/lib/diary-mood-storage";

type MoodIconProps = {
  id: MoodId;
  size?: number;
  className?: string;
};

// Lucide-derived line-face / semantic icons, one per mood. SVG paths are
// inlined (no external dependency) at the same 0-24 viewBox used before, so
// sizing and stroke behavior stay consistent with the calendar cells and
// picker grid.
export function MoodIcon({ id, size = 22, className }: MoodIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };

  switch (id) {
    case "happy":
      // Lucide: smile
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" x2="9.01" y1="9" y2="9" />
          <line x1="15" x2="15.01" y1="9" y2="9" />
        </svg>
      );
    case "calm":
      // Lucide: meh
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <line x1="8" x2="16" y1="15" y2="15" />
          <line x1="9" x2="9.01" y1="9" y2="9" />
          <line x1="15" x2="15.01" y1="9" y2="9" />
        </svg>
      );
    case "sad":
      // Lucide: frown
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
          <line x1="9" x2="9.01" y1="9" y2="9" />
          <line x1="15" x2="15.01" y1="9" y2="9" />
        </svg>
      );
    case "angry":
      // Lucide: angry
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
          <path d="M7.5 8 10 9" />
          <path d="m14 9 2.5-1" />
          <path d="M9 10h.01" />
          <path d="M15 10h.01" />
        </svg>
      );
    case "excited":
      // Lucide: laugh
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z" />
          <line x1="9" x2="9.01" y1="9" y2="9" />
          <line x1="15" x2="15.01" y1="9" y2="9" />
        </svg>
      );
    case "anxious":
      // Lucide: annoyed
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M8 15h8" />
          <path d="M8 9h2" />
          <path d="M14 9h2" />
        </svg>
      );
    case "tired":
      // Lucide: battery-low (semantic substitute — no direct low-energy face)
      return (
        <svg {...common}>
          <path d="M22 14v-4" />
          <path d="M6 14v-4" />
          <rect x="2" y="6" width="16" height="12" rx="2" />
        </svg>
      );
    case "emo":
      // Lucide: cloud-rain (semantic substitute — no direct emo face)
      return (
        <svg {...common}>
          <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
          <path d="M16 14v6" />
          <path d="M8 14v6" />
          <path d="M12 16v6" />
        </svg>
      );
    case "love":
      // Lucide: heart
      return (
        <svg {...common}>
          <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
        </svg>
      );
    case "surprised":
      // Lucide: circle-ellipsis
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M17 12h.01M12 12h.01M7 12h.01" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

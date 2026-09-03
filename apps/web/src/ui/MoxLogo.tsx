/**
 * Canonical Mox logo component. Uses the official SVG geometry with
 * `currentColor` for automatic theme adaptation.
 *
 * variant="full"  — horizontal wordmark (symbol + MOX lettering)
 * variant="mark"  — symbol only (for collapsed sidebar)
 */

export function MoxLogo({ variant = "full", className }: { variant?: "full" | "mark"; className?: string }) {
  if (variant === "mark") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 226 220"
        fill="none"
        role="img"
        aria-label="Mox"
        className={className}
      >
        <g fill="currentColor">
          <path d="M30 28C30 22 37 19 42 23L112 75V132L30 72V28Z" />
          <path d="M196 28C196 22 189 19 184 23L114 75V132L196 72V28Z" />
          <path d="M30 190C30 196 37 199 42 195L112 143L72 114L30 145V190Z" />
          <path d="M196 190C196 196 189 199 184 195L114 143L154 114L196 145V190Z" />
        </g>
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 760 220"
      fill="none"
      role="img"
      aria-label="Mox"
      className={className}
    >
      <g fill="currentColor">
        {/* MOX SYMBOL */}
        <path d="M30 28C30 22 37 19 42 23L112 75V132L30 72V28Z" />
        <path d="M196 28C196 22 189 19 184 23L114 75V132L196 72V28Z" />
        <path d="M30 190C30 196 37 199 42 195L112 143L72 114L30 145V190Z" />
        <path d="M196 190C196 196 189 199 184 195L114 143L154 114L196 145V190Z" />

        {/* M */}
        <path d="M265 52H292L344 111L396 52H423V178H397V91L344 150L291 91V178H265Z" />

        {/* O */}
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M500 49C458 49 429 77 429 115C429 153 458 181 500 181C542 181 571 153 571 115C571 77 542 49 500 49ZM500 76C526 76 544 92 544 115C544 138 526 154 500 154C474 154 456 138 456 115C456 92 474 76 500 76Z"
        />

        {/* X */}
        <path d="M585 54H618L653 96L688 54H721L670 115L724 178H691L653 133L615 178H582L636 115Z" />
      </g>
    </svg>
  );
}

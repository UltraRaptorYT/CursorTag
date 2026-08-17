import { MousePointer2 } from "lucide-react";

export function CursorTagLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="relative grid size-9 place-items-center rounded-[12px] bg-[#b7ff45] text-[#10120f] shadow-[0_0_24px_rgba(183,255,69,.22)]">
        <MousePointer2 className="size-[18px] fill-current" strokeWidth={2.4} />
        <span className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-[#11130f] bg-[#ff5c5c]" />
      </span>
      {!compact && <span className="text-lg font-black tracking-[-0.045em]">CURSOR TAG</span>}
    </span>
  );
}

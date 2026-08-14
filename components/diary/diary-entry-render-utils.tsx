import type { DiaryEntryBlock } from "@/lib/diary-entry-types";

export function formatEntryDateParts(value: string): { date: string; weekdayTime: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value || "未知时间", weekdayTime: "" };
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    weekdayTime: `${days[date.getDay()]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

export function blockPlainText(block: DiaryEntryBlock): string {
  if (block.type === "paragraph" || block.type === "quote") return block.text;
  if (block.type === "correction") return block.replacement || block.text;
  if (block.type === "image") return block.caption || block.description;
  if (block.type === "todo") return block.items.map(item => item.text).join(" / ");
  return "";
}

export function DiaryBlockView({ block }: { block: DiaryEntryBlock }) {
  if (block.type === "quote") {
    return <blockquote className="diary-entry-quote">{block.text}</blockquote>;
  }
  if (block.type === "correction") {
    return (
      <p className="diary-entry-correction">
        <del>{block.text}</del>
        {block.replacement ? <ins>{block.replacement}</ins> : null}
      </p>
    );
  }
  if (block.type === "todo") {
    return (
      <section className="diary-entry-todo">
        {block.title ? <h3>{block.title}</h3> : null}
        <ul>
          {block.items.map((item, index) => (
            <li key={`${item.text}-${index}`} data-done={item.done ? "true" : "false"}>
              <span />
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (block.type === "image") {
    return (
      <figure className="diary-entry-image-block">
        <div>{block.description}</div>
        {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  return <p className="diary-entry-paragraph">{block.text}</p>;
}

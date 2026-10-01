/** Native disclosure keeps email history compact and supports keyboard navigation. */
export function EmailBody({ body }: { body: string }) {
  const text = body.replace(/\s+/g, " ").trim();
  const preview = text.length > 180 ? text.slice(0, 180) + "…" : text;
  return (
    <details className="group min-w-0 max-w-full">
      <summary className="cursor-pointer break-words rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        <span className="whitespace-normal group-open:hidden">{preview || "Empty email"}</span>
        <span className="mt-1 block text-xs font-medium underline group-open:hidden">Read full email</span>
        <span className="hidden text-xs font-medium underline group-open:inline">Collapse email</span>
      </summary>
      <div className="mt-2 whitespace-pre-wrap break-words">{body || "Empty email"}</div>
    </details>
  );
}

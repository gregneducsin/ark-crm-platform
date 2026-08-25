import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AiAssistantMessage } from "@luma/shared";
import { useAskAiAssistant } from "../hooks/useAiAssistant";
import { Button } from "./ui";
import { ApiError } from "../hooks/useAuth";

export function AiAssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiAssistantMessage[]>([]);
  const ask = useAskAiAssistant();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, ask.isPending]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || ask.isPending) return;

    const history = messages;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");

    ask.mutate(
      { question, history },
      {
        onSuccess: (data) => setMessages((m) => [...m, { role: "assistant", content: data.answer }]),
        onError: (err) =>
          setMessages((m) => [
            ...m,
            { role: "assistant", content: err instanceof ApiError ? err.message : "Something went wrong. Please try again." },
          ]),
      },
    );
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-20 right-6 z-50 flex h-[520px] w-96 flex-col rounded-lg border border-gray-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
            <p className="text-sm font-semibold text-gray-900">Ask about your data</p>
            <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              ✕
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="text-sm text-gray-400">
                Ask things like &ldquo;how many leads did we get last week?&rdquo; or &ldquo;what&rsquo;s our marketing CPA this
                month?&rdquo;
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                <span
                  className={
                    m.role === "user"
                      ? "inline-block whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-2 text-left text-sm text-white"
                      : "inline-block whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800"
                  }
                >
                  {m.content}
                </span>
              </div>
            ))}
            {ask.isPending && <p className="text-sm text-gray-400">Thinking…</p>}
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-gray-200 p-3">
            <input
              className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Ask a question…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={ask.isPending}
            />
            <Button type="submit" disabled={ask.isPending || !input.trim()}>
              Send
            </Button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-2xl text-white shadow-lg hover:bg-blue-700"
        aria-label="Ask about your data"
      >
        💬
      </button>
    </>
  );
}

import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
  componentStack: string;
}

/**
 * Last line of defence for render crashes. Without it React unmounts the whole
 * tree and the window is left plain black; this keeps the failure visible and
 * recoverable.
 */
export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Akflix render failure", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const details = [error.stack || `${error.name}: ${error.message}`, componentStack.trim()]
      .filter(Boolean)
      .join("\n\nComponent stack:\n");
    return (
      <div role="alert" className="min-h-full overflow-auto bg-black px-12 py-[72px] text-white">
        <h1 className="text-[22px] font-bold">Akflix hit a problem showing this screen</h1>
        <p className="mt-2 text-sm text-zinc-300">{error.message || "Unknown error"}</p>
        <pre className="mt-5 max-w-[960px] select-text whitespace-pre-wrap break-words rounded-xl border border-white/25 p-4 font-mono text-xs leading-5 text-zinc-100">
          {details}
        </pre>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 h-10 rounded-full bg-white px-5 text-sm font-bold text-black transition hover:bg-zinc-200"
        >
          Reload
        </button>
      </div>
    );
  }
}

export function LoadingState() {
  return (
    <div className="flex items-center justify-center min-h-[32rem]">
      <div className="flex flex-col items-center gap-4">
        <span className="loading loading-spinner loading-lg text-primary" />
        <p className="text-base-content/70">Loading telemetry data...</p>
      </div>
    </div>
  );
}

export function DisabledState() {
  return (
    <div className="flex items-center justify-center min-h-[32rem]">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4 opacity-50" aria-hidden="true">
          🔒
        </div>
        <h2 className="text-2xl font-bold mb-2">Observability Disabled</h2>
        <p className="text-base-content/70">
          The observability dashboard is not enabled in this environment. To enable it, the
          administrator must set the <code>OBSERVABILITY_UI_TOKEN</code> environment variable.
        </p>
      </div>
    </div>
  );
}

export function UnreachableState({ onRetry, onLogout }: { onRetry: () => void; onLogout: () => void }) {
  return (
    <div>
      <div className="flex justify-end mb-4">
        <button type="button" className="btn btn-sm btn-outline btn-error" onClick={onLogout}>
          Logout
        </button>
      </div>
      <div className="flex items-center justify-center min-h-[28rem]">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4 opacity-50" aria-hidden="true">
            🔌
          </div>
          <h2 className="text-2xl font-bold mb-2 text-warning">Telemetry Backend Unreachable</h2>
          <p className="text-base-content/70 mb-6">
            The dashboard is authenticated, but the Langfuse backend proxy is currently not
            responding. Live sessions may still be functioning, but historical traces cannot be
            loaded.
          </p>
          <button type="button" className="btn btn-outline" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

export function TraceNotFoundState({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center justify-center min-h-[32rem]">
      <div className="text-center max-w-md">
        <h2 className="text-2xl font-bold mb-2">Trace not found</h2>
        <p className="text-base-content/70 mb-6">This trace does not exist or is no longer available.</p>
        <button type="button" className="btn btn-outline" onClick={onBack}>
          Back to Dashboard
        </button>
      </div>
    </div>
  );
}

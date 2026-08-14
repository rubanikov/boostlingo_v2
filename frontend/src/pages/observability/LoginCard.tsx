import { useState, type FormEvent } from 'react';
import { login } from './observabilityApi';

interface LoginCardProps {
  onLoggedIn: () => void;
  onDisabled: () => void;
}

export function LoginCard({ onLoggedIn, onDisabled }: LoginCardProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login(token);
    setSubmitting(false);

    if (result.status === 'ok') {
      setToken('');
      onLoggedIn();
      return;
    }
    if (result.status === 'disabled') {
      onDisabled();
      return;
    }
    if (result.status === 'unauthenticated') {
      setError('Invalid operator token.');
      setToken('');
      return;
    }
    setError('Could not reach the server. Try again.');
  }

  return (
    <div className="flex items-center justify-center min-h-[32rem]">
      <div className="card w-96 bg-base-200 card-border shadow-xl">
        <div className="card-body">
          <h2 className="card-title justify-center mb-2">Observability Access</h2>
          <p className="text-center text-sm text-base-content/70 mb-6">
            Enter the operator token to view telemetry data.
          </p>

          {error ? (
            <div role="alert" className="alert alert-error mb-4">
              <span>{error}</span>
            </div>
          ) : null}

          <form onSubmit={handleSubmit}>
            <div className="form-control w-full mb-4">
              <label className="label" htmlFor="operator-token">
                <span className="label-text">Operator Token</span>
              </label>
              <input
                id="operator-token"
                type="password"
                name="token"
                autoComplete="off"
                placeholder="••••••••••••"
                className="input input-bordered w-full"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={submitting}>
              Access Dashboard
            </button>
          </form>

          <p className="text-xs text-center text-base-content/50 mt-4">
            Signed in until you log out or close the browser.
          </p>
        </div>
      </div>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { ErrorBox } from '../components/ui';

export function LoginPage({ onLoggedIn, serverError }: { onLoggedIn: () => void; serverError?: unknown }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(serverError ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      onLoggedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="panel" onSubmit={submit}>
        <header><h2><span className="mono">eccö RADAR</span></h2><span className="badge">private</span></header>
        <div className="body stack">
          <label className="field"><span>Email</span>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field"><span>Password</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <ErrorBox error={error} />
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="small muted">Accounts are created on the server with <code>npm run create-user</code>. There is no public sign-up.</p>
        </div>
      </form>
    </div>
  );
}

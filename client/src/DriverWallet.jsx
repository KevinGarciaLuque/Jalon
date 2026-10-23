import { useEffect, useState } from 'react';
import { API, api, authFetch, toJpeg, money2 } from './lib.js';
import { Panel } from './Menu.jsx';

const BANKS = ['BAC Credomatic', 'Ficohsa', 'Banco Atlántida', 'Banpaís', 'Davivienda', 'Banco de Occidente', 'Promerica', 'Lafise', 'Tigo Money', 'Otro'];
const KIND = { topup: 'Recarga', commission: 'Comisión de viaje', bonus: 'Crédito', adjustment: 'Ajuste' };
const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

// Saldo del conductor: pedir una recarga, transferir a la cuenta que le asignen (24 h), subir el comprobante, y sus movimientos
export default function DriverWallet({ wallet, reload, onClose }) {
  const { request } = wallet; // su solicitud más reciente: waiting | assigned (con la cuenta) | used | rejected | expired | cancelled
  const [f, setF] = useState({ amount: request?.status === 'assigned' ? String(request.amount) : '', bank: '', reference: '' });
  const [want, setWant] = useState(''); // monto a solicitar
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ ok: false, text: '' });
  const [copied, setCopied] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const account = request?.status === 'assigned' ? request.account : null;
  // Cuando le asignan la cuenta, el monto del comprobante empieza con lo que pidió
  useEffect(() => { if (account) setF((cur) => (cur.amount ? cur : { ...cur, amount: String(request.amount) })); }, [request?.id, !!account]); // eslint-disable-line react-hooks/exhaustive-deps
  const low = wallet.balance < wallet.minBalance;

  async function copy() {
    try { await navigator.clipboard.writeText(account.number); setCopied(true); } catch { window.prompt('Copia el número de cuenta:', account.number); }
  }

  async function ask(e) {
    e.preventDefault();
    setBusy(true);
    setMsg({ ok: false, text: '' });
    try {
      await api('driver/topup-requests', { amount: Number(want) });
      setWant('');
      reload();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }
  async function cancelRequest() {
    if (!window.confirm('¿Cancelar tu solicitud de recarga?')) return;
    try { await api(`driver/topup-requests/${request.id}/cancel`, {}); reload(); } catch (err) { setMsg({ ok: false, text: err.message }); }
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return setMsg({ ok: false, text: 'Sube la foto o captura de tu comprobante' });
    setBusy(true);
    setMsg({ ok: false, text: '' });
    try {
      const image = await toJpeg(file);
      const res = await authFetch(`${API}/api/driver/topups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(f.amount), bank: f.bank, reference: f.reference, image }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo enviar la recarga');
      setF({ amount: '', bank: '', reference: '' });
      setFile(null);
      setMsg({ ok: true, text: 'Recibimos tu comprobante. El equipo lo revisará y te avisaremos cuando se acredite el saldo.' });
      reload();
    } catch (err) {
      setMsg({ ok: false, text: err.name === 'InvalidStateError' ? 'No se pudo leer esa imagen. Prueba con otra foto.' : err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel onClose={onClose} labelledBy="wallet-title" className="top">
      <div className="overlay-head">
        <b id="wallet-title">Mi saldo</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <div className={`balance ${low ? 'low' : ''}`}>
          <span className="muted">Saldo disponible</span>
          <b data-testid="balance">{money2(wallet.balance)}</b>
          <span className="muted small">Se descuenta {wallet.percent}% de comisión de cada viaje que cobras en efectivo. Necesitas al menos {money2(wallet.minBalance)} para recibir viajes.</span>
        </div>
        {low && <div className="hint danger">Tu saldo está por debajo del mínimo. Recarga para volver a recibir viajes.</div>}

        {/* 1. Pedir la recarga: la cuenta para transferir se la asigna el equipo (no se muestra a todos) */}
        {(!request || !['waiting', 'assigned'].includes(request.status)) && (
          <form className="req" onSubmit={ask}>
            <b>Recargar saldo</b>
            {request?.status === 'rejected' && <div className="hint danger">Tu última solicitud fue rechazada: {request.note}</div>}
            {request?.status === 'expired' && <div className="hint">La cuenta que te asignamos venció sin comprobante. Si todavía quieres recargar, vuelve a solicitarla.</div>}
            <p className="muted small">Escribe cuánto quieres recargar. El equipo te asigna una cuenta de Ktracho GO para transferir y te avisamos aquí y en tu celular.</p>
            <input aria-label="Monto a recargar en lempiras" placeholder={`Monto a recargar (L ${wallet.topupMin} a L ${wallet.topupMax})`} inputMode="decimal" value={want} onChange={(e) => setWant(e.target.value)} required />
            {msg.text && !msg.ok && <div className="error">{msg.text}</div>}
            {msg.ok && <div className="hint ok">{msg.text}</div>}
            <button className="primary" disabled={busy}>{busy ? 'Enviando…' : 'Solicitar recarga'}</button>
          </form>
        )}

        {/* 2. Esperando la cuenta */}
        {request?.status === 'waiting' && (
          <div className="req" role="status">
            <b>⏳ Esperando tu cuenta para transferir</b>
            <p>Pediste recargar <b>{money2(request.amount)}</b>. En cuanto el equipo te asigne una cuenta te avisamos aquí y en tu celular.</p>
            {msg.text && <div className="error">{msg.text}</div>}
            <button type="button" className="sm" onClick={cancelRequest}>Cancelar solicitud</button>
          </div>
        )}

        {/* 3. Con la cuenta asignada: transferir (24 horas) y subir el comprobante */}
        {account && (
          <div className="req">
            <b>1. Transfiere {money2(request.amount)} a esta cuenta</b>
            <div className="bank">
              <div><span className="muted">Banco</span> <b>{account.bank}</b></div>
              {account.type && <div><span className="muted">Tipo</span> <b>{account.type}</b></div>}
              <div><span className="muted">Cuenta</span> <b data-testid="bank-account">{account.number}</b> <button type="button" className="sm" onClick={copy}>{copied ? '✓ Copiada' : 'Copiar'}</button></div>
              <div><span className="muted">A nombre de</span> <b>{account.holder}</b></div>
              {account.note && <div className="muted small">{account.note}</div>}
            </div>
            <p className="hint">Esta cuenta es solo para ti y vence el <b>{when(request.expiresAt)}</b>. Después se oculta y tendrías que pedirla de nuevo.</p>
          </div>
        )}

        {account && (
        <form className="req" onSubmit={submit}>
          <b>2. Sube tu comprobante</b>
          <input aria-label="Monto transferido en lempiras" placeholder={`Monto transferido (L ${wallet.topupMin} a L ${wallet.topupMax})`} inputMode="decimal" value={f.amount} onChange={set('amount')} required />
          <input list="bancos" aria-label="Banco desde el que transferiste" placeholder="Banco desde el que transferiste" value={f.bank} onChange={set('bank')} required />
          <datalist id="bancos">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
          <input aria-label="Número de referencia o de transacción" placeholder="Número de referencia o de transacción" value={f.reference} onChange={set('reference')} required />
          <label className={`upload ${busy ? 'disabled' : ''}`}>
            {file ? `✓ ${file.name}` : '📷 Foto o captura del comprobante'}
            <input type="file" accept="image/*" disabled={busy} onChange={(e) => setFile(e.target.files[0] || null)} />
          </label>
          {msg.text && <div className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar para aprobación'}</button>
          <p className="muted small">Un administrador lo revisa y acredita el monto que muestra el comprobante. Si no es legible o no coincide, te explicaremos por qué.</p>
        </form>
        )}

        {wallet.topups.length > 0 && (
          <>
            <b>Mis recargas</b>
            {wallet.topups.map((t) => (
              <div className="req" key={t.id}>
                <div className="row between">
                  <b>{money2(t.amount)} · {t.bank}</b>
                  <span className={`pill ${t.status === 'pending' ? 'pending' : t.status === 'approved' ? 'active' : 'blocked'}`}>
                    {t.status === 'pending' ? 'En revisión' : t.status === 'approved' ? `Aprobada +${money2(t.approved_amount)}` : 'Rechazada'}
                  </span>
                </div>
                <div className="muted small">Ref. {t.reference} · {when(t.created_at)}</div>
                {t.review_note && <div className="hint danger">{t.review_note}</div>}
              </div>
            ))}
          </>
        )}

        {wallet.entries.length > 0 && (
          <>
            <b>Movimientos</b>
            {wallet.entries.map((e) => (
              <div className="row between entry" key={e.id}>
                <span>{KIND[e.kind]}{e.ride_id ? ` · viaje #${e.ride_id}` : ''}<span className="muted small"> {when(e.created_at)}</span></span>
                <b className={Number(e.amount) < 0 ? 'neg' : 'pos'}>{Number(e.amount) > 0 ? '+' : ''}{money2(e.amount)}</b>
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}

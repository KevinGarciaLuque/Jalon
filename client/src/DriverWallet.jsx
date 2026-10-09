import { useState } from 'react';
import { API, toJpeg, money2 } from './lib.js';

const BANKS = ['BAC Credomatic', 'Ficohsa', 'Banco Atlántida', 'Banpaís', 'Davivienda', 'Banco de Occidente', 'Promerica', 'Lafise', 'Tigo Money', 'Otro'];
const KIND = { topup: 'Recarga', commission: 'Comisión de viaje', bonus: 'Crédito', adjustment: 'Ajuste' };
const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

// Saldo del conductor: cómo recargar (transferencia + comprobante), sus recargas y sus movimientos
export default function DriverWallet({ token, wallet, reload, onClose }) {
  const [f, setF] = useState({ amount: '', bank: '', reference: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ ok: false, text: '' });
  const [copied, setCopied] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { bank } = wallet;
  const low = wallet.balance < wallet.minBalance;

  async function copy() {
    try { await navigator.clipboard.writeText(bank.account); setCopied(true); } catch { window.prompt('Copia el número de cuenta:', bank.account); }
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return setMsg({ ok: false, text: 'Sube la foto o captura de tu comprobante' });
    setBusy(true);
    setMsg({ ok: false, text: '' });
    try {
      const image = await toJpeg(file);
      const res = await fetch(`${API}/api/driver/topups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
    <div className="overlay top">
      <div className="overlay-head">
        <b>Mi saldo</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <div className={`balance ${low ? 'low' : ''}`}>
          <span className="muted">Saldo disponible</span>
          <b data-testid="balance">{money2(wallet.balance)}</b>
          <span className="muted small">Se descuenta {wallet.percent}% de comisión de cada viaje que cobras en efectivo. Necesitas al menos {money2(wallet.minBalance)} para recibir viajes.</span>
        </div>
        {low && <div className="hint danger">Tu saldo está por debajo del mínimo. Recarga para volver a recibir viajes.</div>}

        <div className="req">
          <b>1. Transfiere a la cuenta de Jalón</b>
          {bank.account ? (
            <div className="bank">
              <div><span className="muted">Banco</span> <b>{bank.name}</b></div>
              {bank.type && <div><span className="muted">Tipo</span> <b>{bank.type}</b></div>}
              <div><span className="muted">Cuenta</span> <b data-testid="bank-account">{bank.account}</b> <button type="button" className="sm" onClick={copy}>{copied ? '✓ Copiada' : 'Copiar'}</button></div>
              <div><span className="muted">A nombre de</span> <b>{bank.holder}</b></div>
              {bank.note && <div className="muted small">{bank.note}</div>}
            </div>
          ) : (
            <p className="muted">Todavía no hay una cuenta configurada. Pregunta a soporte.</p>
          )}
        </div>

        <form className="req" onSubmit={submit}>
          <b>2. Sube tu comprobante</b>
          <input placeholder={`Monto transferido (L ${wallet.topupMin} a L ${wallet.topupMax})`} inputMode="decimal" value={f.amount} onChange={set('amount')} required />
          <input list="bancos" placeholder="Banco desde el que transferiste" value={f.bank} onChange={set('bank')} required />
          <datalist id="bancos">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
          <input placeholder="Número de referencia o de transacción" value={f.reference} onChange={set('reference')} required />
          <label className={`upload ${busy ? 'disabled' : ''}`}>
            {file ? `✓ ${file.name}` : '📷 Foto o captura del comprobante'}
            <input type="file" accept="image/*" disabled={busy} onChange={(e) => setFile(e.target.files[0] || null)} />
          </label>
          {msg.text && <div className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar para aprobación'}</button>
          <p className="muted small">Un administrador lo revisa y acredita el monto que muestra el comprobante. Si no es legible o no coincide, te explicaremos por qué.</p>
        </form>

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
    </div>
  );
}

import { useEffect, useState } from 'react';

const EMPTY = { bank: '', type: '', number: '', holder: '', note: '' };

// Cuentas de Ktracho GO para recibir transferencias. No se muestran a todos los conductores:
// el personal asigna una a cada solicitud de recarga y ese conductor la ve 24 horas.
// `onCount(n)`: cuántas cuentas activas hay (Ajustes avisa si la comisión está activa y no hay ninguna).
export default function BankAccounts({ call, onError, onCount }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null); // { id?, ...campos } que se está escribiendo
  const [busy, setBusy] = useState(false);

  const load = () => call('bank-accounts').then((r) => { setList(r.accounts); onCount?.(r.accounts.filter((a) => a.active).length); }).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true);
    try {
      const body = { bank: edit.bank, type: edit.type, number: edit.number, holder: edit.holder, note: edit.note };
      if (edit.id) await call(`bank-accounts/${edit.id}`, body, 'PUT'); else await call('bank-accounts', body);
      setEdit(null);
      await load();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(a) {
    if (a.active && !window.confirm(`¿Desactivar la cuenta de ${a.bank}? Ya no se podrá asignar a los conductores.`)) return;
    try { await call(`bank-accounts/${a.id}`, { active: !a.active }, 'PUT'); await load(); } catch (e) { onError(e.message); }
  }
  const set = (k) => (e) => setEdit({ ...edit, [k]: e.target.value });

  return (
    <section className="req settings" aria-labelledby="banks-title">
      <b id="banks-title">Cuentas bancarias para las recargas</b>
      <p className="muted small">Los conductores no las ven: cuando uno solicita una recarga, en Recargas le asignas una y solo él la ve durante 24 horas. También se usa la primera activa para los alquileres pagados por transferencia.</p>
      {list === null && <p className="muted small">Cargando…</p>}
      {list?.length === 0 && !edit && <p className="muted">Todavía no hay cuentas. Agrega la primera.</p>}
      {list?.map((a) => (
        <div key={a.id} className={`ucard bank-row${a.active ? '' : ' off'}`}>
          <div className="grow">
            <b>{a.bank}</b>{a.type ? <span className="muted"> · {a.type}</span> : null}
            <div className="small">{a.number} · a nombre de {a.holder}</div>
            {a.note && <div className="muted small">{a.note}</div>}
          </div>
          <span className={`pill ${a.active ? 'active' : 'blocked'}`}>{a.active ? 'Activa' : 'Desactivada'}</span>
          <div className="row wrap">
            <button type="button" className="sm" onClick={() => setEdit({ id: a.id, bank: a.bank, type: a.type || '', number: a.number, holder: a.holder, note: a.note || '' })}>Editar</button>
            <button type="button" className="sm" onClick={() => toggle(a)}>{a.active ? 'Desactivar' : 'Activar'}</button>
          </div>
        </div>
      ))}
      {edit ? (
        <div className="req bank-edit">
          <b>{edit.id ? 'Editar cuenta' : 'Nueva cuenta'}</b>
          <label>Banco<input value={edit.bank} onChange={set('bank')} placeholder="Ej. BAC Credomatic" maxLength={60} /></label>
          <label>Tipo de cuenta<input value={edit.type} onChange={set('type')} placeholder="Ahorros o Cheques" maxLength={40} /></label>
          <label>Número de cuenta<input value={edit.number} onChange={set('number')} maxLength={60} /></label>
          <label>A nombre de<input value={edit.holder} onChange={set('holder')} placeholder="Nombre de la empresa" maxLength={100} /></label>
          <label>Indicaciones para el conductor (opcional)<textarea rows={2} maxLength={400} value={edit.note} onChange={set('note')} placeholder="Ej. Escribe tu nombre completo en la referencia" /></label>
          <div className="row wrap">
            <button type="button" className="primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar cuenta'}</button>
            <button type="button" onClick={() => setEdit(null)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setEdit({ ...EMPTY })}>+ Agregar cuenta</button>
      )}
    </section>
  );
}

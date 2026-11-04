import { useEffect, useState } from 'react';
import { Empty, Loading } from './components.jsx';
import { Panel } from './Menu.jsx';
import { apiGet, lempiras } from './lib.js';

// «Invita y gana»: el código de la persona, el enlace para compartir y a quién invitó
const STATE = {
  pending: ['pending', 'Pendiente'],
  rewarded: ['active', '✓ Ganado'],
  rejected: ['', 'Sin premio'],
};
const day = (d) => new Date(d).toLocaleDateString('es-HN', { day: 'numeric', month: 'short' });

export default function Invite({ token, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { apiGet('referrals/me', token).then(setData).catch((e) => setError(e.message)); }, [token]);

  const prize = data && (data.driver ? `${lempiras(data.reward)} en tu saldo` : `${lempiras(data.reward)} de descuento en un viaje`);
  const message = data && `¡Viaja con Ktracho GO! 🚗 Tú pones el precio y tu conductor llega.${data.welcome > 0 ? ` Con mi código ${data.code} tienes ${lempiras(data.welcome)} menos en tu primer viaje.` : ` Usa mi código ${data.code} al registrarte.`} Entra aquí: ${data.link}`;
  async function share() {
    try {
      if (navigator.share) return await navigator.share({ title: 'Ktracho GO', text: message });
    } catch (e) {
      if (e.name === 'AbortError') return; // cerró el menú de compartir
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copia tu enlace:', data.link);
    }
  }

  return (
    <Panel onClose={onClose} labelledBy="invite-title">
      <div className="overlay-head">
        <b id="invite-title">Invita y gana</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {error && <div className="error">{error}</div>}
        {!data && !error && <Loading />}
        {data && !data.enabled && <Empty title="Por ahora no hay premios por invitar">Te avisaremos cuando vuelvan.</Empty>}
        {data?.enabled && (
          <>
            <div className="req invite-card">
              <span className="muted small">Tu código</span>
              <b className="invite-code" aria-label="Tu código de invitación">{data.code}</b>
              <p>
                Invita a tus amigos. Cuando tu invitado termine su primer viaje, tú ganas <b>{prize}</b>.
                {data.welcome > 0 && <> Y tu invitado tiene <b>{lempiras(data.welcome)} menos</b> en su primer viaje.</>}
              </p>
              <div className="row wrap">
                <button className="primary grow" onClick={share}>Compartir por WhatsApp</button>
                <button className="grow" onClick={copy}>{copied ? '✓ Enlace copiado' : 'Copiar enlace'}</button>
              </div>
              <p className="muted small">Si tu invitado es conductor, el premio llega cuando termine sus primeros {data.driverRides} viajes.</p>
              <p className="muted small">Hasta {data.monthlyMax} premios por mes. Si un conductor lleva a su propio invitado, ese viaje no cuenta.</p>
            </div>
            {data.earned > 0 && <p className="invite-earned" role="status">🎁 Has ganado <b>{lempiras(data.earned)}</b> invitando</p>}
            <b className="small">Tus invitados</b>
            {!data.invites.length && <Empty title="Todavía no has invitado a nadie">Comparte tu enlace: tu invitado se registra con él y tu código ya va escrito.</Empty>}
            {data.invites.map((i) => {
              const [cls, label] = STATE[i.status];
              return (
                <div className="req" key={i.id}>
                  <div className="row between">
                    <span><b>{i.name}</b> <span className="muted small">· {i.role === 'driver' ? 'conductor' : 'pasajero'} · {day(i.createdAt)}</span></span>
                    <span className={`pill ${cls}`}>{label}</span>
                  </div>
                  {i.status === 'pending' && <span className="muted small">{i.role === 'driver' ? 'Esperando que termine sus primeros viajes' : 'Esperando su primer viaje'}</span>}
                  {i.status === 'rewarded' && <span className="small">Ganaste {i.rewardKind === 'wallet' ? `${lempiras(i.reward)} en tu saldo` : `un código de ${lempiras(i.reward)} (aparece al pedir tu viaje)`}</span>}
                  {i.status === 'rejected' && i.reason && <span className="muted small">{i.reason}</span>}
                </div>
              );
            })}
          </>
        )}
      </div>
    </Panel>
  );
}

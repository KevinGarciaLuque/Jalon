import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import markImg from './assets/logo-marca.webp';
import { Loading } from './components.jsx';

// Compartir la app (permiso 'share'): un QR para pasajeros y otro para conductores, como imagen o como enlace por WhatsApp
const KINDS = [
  {
    key: 'passenger',
    title: 'Para pasajeros',
    tagline: 'Pide tu viaje. Tú pones el precio.',
    file: 'ktracho-go-pasajeros.png',
    message: (url) => `¡Pide tu viaje con Ktracho GO! 🚗 Tú pones el precio y tu conductor llega. Entra aquí: ${url}`,
  },
  {
    key: 'driver',
    title: 'Para conductores',
    tagline: '¿Tienes carro o moto? Maneja con nosotros.',
    file: 'ktracho-go-conductores.png',
    message: (url) => `¿Tienes carro o moto? Gana dinero manejando con Ktracho GO 🚗 Regístrate como conductor aquí: ${url}`,
  },
];

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// La tarjeta que se comparte (1080×1350, el tamaño que mejor se ve en WhatsApp y en estados):
// logo, nombre, para quién es, el QR (verde, con el símbolo al centro) y la dirección
async function drawCard(kind, url) {
  await document.fonts?.ready;
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#14802f';
  g.fillRect(0, 0, W, 18);

  const mark = await loadImage(markImg);
  const mw = 240;
  const mh = (mark.height / mark.width) * mw;
  g.drawImage(mark, (W - mw) / 2, 70, mw, mh);

  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const display = "800 92px 'Bricolage Grotesque', 'Segoe UI', sans-serif";
  g.font = display;
  const name1 = 'Ktracho ';
  const w1 = g.measureText(name1).width;
  const w2 = g.measureText('GO').width;
  const left = (W - w1 - w2) / 2;
  g.textAlign = 'left';
  g.fillStyle = '#0d1b2a';
  g.fillText(name1, left, 400);
  g.fillStyle = '#14802f';
  g.fillText('GO', left + w1, 400);
  g.textAlign = 'center';
  g.fillStyle = '#0d1b2a';
  g.font = "700 46px 'Figtree', system-ui, sans-serif";
  g.fillText(kind.title, W / 2, 476);
  g.fillStyle = '#4a5a52';
  g.font = "500 36px 'Figtree', system-ui, sans-serif";
  g.fillText(kind.tagline, W / 2, 530);

  // QR con corrección alta: aguanta el símbolo encima sin dejar de leerse
  const qr = document.createElement('canvas');
  await QRCode.toCanvas(qr, url, { errorCorrectionLevel: 'H', margin: 2, width: 620, color: { dark: '#0b6e2e', light: '#ffffff' } });
  const qx = (W - 620) / 2;
  const qy = 580;
  g.drawImage(qr, qx, qy, 620, 620);
  const badge = 150;
  g.fillStyle = '#ffffff';
  roundRect(g, (W - badge) / 2, qy + (620 - badge) / 2, badge, badge, 28);
  g.fill();
  const bw = 124;
  const bh = (mark.height / mark.width) * bw;
  g.drawImage(mark, (W - bw) / 2, qy + (620 - bh) / 2, bw, bh);

  g.fillStyle = '#14802f';
  g.font = "800 44px 'Figtree', system-ui, sans-serif";
  g.fillText(new URL(url).host, W / 2, 1270); // solo «ktrachogo.com»: el QR ya lleva el enlace completo
  g.fillStyle = '#4a5a52';
  g.font = "500 30px 'Figtree', system-ui, sans-serif";
  g.fillText('Escanea el código con la cámara de tu celular', W / 2, 1316);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

function ShareCard({ kind, url }) {
  const [png, setPng] = useState(null); // { blob, src }
  const [note, setNote] = useState('');
  useEffect(() => {
    let src;
    let alive = true;
    drawCard(kind, url).then((blob) => {
      if (!alive) return;
      src = URL.createObjectURL(blob);
      setPng({ blob, src });
    });
    return () => { alive = false; if (src) URL.revokeObjectURL(src); };
  }, [kind, url]);

  const say = (text) => { setNote(text); setTimeout(() => setNote(''), 2500); };
  const file = () => new File([png.blob], kind.file, { type: 'image/png' });
  const canShareFile = () => { try { return !!navigator.canShare?.({ files: [file()] }); } catch { return false; } };

  function download() {
    const a = document.createElement('a');
    a.href = png.src;
    a.download = kind.file;
    a.click();
    say('Imagen descargada: adjúntala en WhatsApp.');
  }
  // En el celular abre el menú de compartir (ahí está WhatsApp); donde no se puede, se descarga
  async function shareImage() {
    if (!canShareFile()) return download();
    try {
      await navigator.share({ files: [file()], text: kind.message(url) });
    } catch (e) {
      if (e.name !== 'AbortError') download();
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      say('¡Enlace copiado!');
    } catch {
      window.prompt('Copia el enlace:', url);
    }
  }
  const whatsapp = () => window.open(`https://wa.me/?text=${encodeURIComponent(kind.message(url))}`, '_blank', 'noopener');

  return (
    <section className="req share-card" aria-label={kind.title}>
      <b>{kind.title}</b>
      {png ? <img className="share-preview" src={png.src} alt={`Código QR de Ktracho GO ${kind.title.toLowerCase()}: ${url}`} /> : <Loading />}
      <code className="share-url">{url}</code>
      <div className="row wrap">
        <button className="primary" disabled={!png} onClick={shareImage}>Compartir imagen</button>
        <button disabled={!png} onClick={download}>Descargar imagen</button>
      </div>
      <div className="row wrap">
        <button onClick={copy}>Copiar enlace</button>
        <button className="whatsapp" onClick={whatsapp}>Enviar por WhatsApp</button>
      </div>
      <p className="muted small" role="status">{note}</p>
    </section>
  );
}

export default function Share({ call, onError }) {
  const [links, setLinks] = useState(null);
  useEffect(() => { call('share').then(setLinks).catch((e) => onError(e.message)); }, [call, onError]);
  if (!links) return <Loading />;
  return (
    <>
      <p className="muted">Comparte Ktracho GO por WhatsApp, en estados o impreso. El de conductores abre el registro con «Soy conductor» ya elegido.</p>
      <div className="share-grid">
        {KINDS.map((k) => <ShareCard key={k.key} kind={k} url={links[k.key]} />)}
      </div>
      <p className="muted small">En la computadora, «Compartir imagen» la descarga: adjúntala en WhatsApp Web. WhatsApp no permite mandar una imagen desde un enlace.</p>
    </>
  );
}

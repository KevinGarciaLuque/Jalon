import { useState } from 'react';
import { newsFor } from './changelog.js';

// Recuerda en este dispositivo cuál fue la última novedad vista (para el punto de «hay algo nuevo»)
const SEEN_KEY = 'jalon:news-seen';
const readSeen = () => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } };
const dateText = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-HN', { dateStyle: 'long' });

export function useNews(role) {
  const news = newsFor(role);
  const [seen, setSeen] = useState(readSeen);
  const markSeen = () => {
    if (!news[0]) return;
    try { localStorage.setItem(SEEN_KEY, news[0].id); } catch { /* sin almacenamiento: el punto vuelve a salir */ }
    setSeen(news[0].id);
  };
  return { news, unseen: !!news[0] && news[0].id !== seen, markSeen };
}

export default function News({ news, onClose }) {
  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Novedades</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {!news.length && <p className="muted">Todavía no hay novedades.</p>}
        {news.map((n) => (
          <div key={n.id} className="req news">
            <span className="muted small">{dateText(n.date)}</span>
            <b>{n.title}</b>
            <ul>{n.items.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

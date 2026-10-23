import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import { apiGet, TILE_URL, TILE_ATTRIBUTION } from './lib.js';
import { CarMarker, FitTo, MapControls, RouteLine, icons, rotateOptions } from './mapParts.jsx';
import { Brand } from './components.jsx';

const STATUS = {
  accepted: 'El conductor va en camino a recoger al pasajero',
  arrived: 'El conductor llegó y espera al pasajero',
  started: 'Viaje en curso',
  completed: 'El viaje terminó',
  cancelled: 'El viaje fue cancelado',
};

// Página pública (sin cuenta) para que un familiar siga el viaje en vivo
export default function Track({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    const load = () =>
      apiGet(`track/${token}`)
        .then((d) => !stop && (setData(d), setError('')))
        .catch((e) => !stop && setError(e.message));
    load();
    const id = setInterval(load, 4000);
    return () => { stop = true; clearInterval(id); };
  }, [token]);

  if (error && !data) {
    return <div className="auth"><h1><Brand size="lg" /></h1><p className="tagline">{error}</p></div>;
  }
  if (!data) return <div className="auth"><p className="tagline pulse">Cargando viaje…</p></div>;

  const points = data.route?.length > 1 ? data.route : [[data.origin.lat, data.origin.lng], [data.dest.lat, data.dest.lng]];

  return (
    <div className="app">
      <header>
        <Brand />
        <span>Seguimiento de viaje</span>
      </header>
      <div className="screen">
        <div className="map">
          <MapContainer center={points[0]} zoom={14} style={{ height: '100%' }} {...rotateOptions()}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
            <MapControls me={data.driverPos || null} modeKey="track" meLabel="Ver el carro" route={points} />
            <FitTo points={points} />
            <RouteLine positions={points} />
            <Marker position={[data.origin.lat, data.origin.lng]} icon={icons.me} />
            <Marker position={[data.dest.lat, data.dest.lng]} icon={icons.dest} />
            {data.driverPos && <CarMarker position={data.driverPos} duration={3800} />}
          </MapContainer>
        </div>
        <div className="sheet">
          <b>{STATUS[data.status]}</b>
          {data.dest.text && <p className="muted">Destino: {data.dest.text}</p>}
          {data.driver && (
            <div className="offer">
              <div>
                <b>{data.driver.name}</b>
                <div className="muted">{data.driver.vehicle} · placa {data.driver.plate}</div>
              </div>
            </div>
          )}
          <p className="muted small">Esta página se actualiza sola. El enlace deja de funcionar poco después de terminar el viaje.</p>
        </div>
      </div>
    </div>
  );
}

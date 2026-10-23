// leaflet-rotate (el mapa que gira) espera a Leaflet como variable global: este archivo se importa antes que él
import L from 'leaflet';

if (typeof window !== 'undefined') window.L = L;

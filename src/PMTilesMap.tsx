import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";

import "maplibre-gl/dist/maplibre-gl.css";

export default function PMTilesMap() {
  const mapContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const pmtiles = new PMTiles(
      "https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles"
    );

    protocol.add(pmtiles);

    const map = new maplibregl.Map({
      container: mapContainer.current,

      style: {
        version: 8,

        sources: {
          protomaps: {
            type: "vector",
            url: "pmtiles://https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles",
          },
        },

        layers: [
          {
            id: "water",
            source: "protomaps",
            "source-layer": "water",
            type: "fill",
            paint: {
              "fill-color": "#99ccff",
            },
          },
        ],
      },

      center: [11.25, 43.77],
      zoom: 10,
    });

    return () => {
      map.remove();
    };
  }, []);

  return (
    <div
      ref={mapContainer}
      style={{
        width: "100%",
        height: "100vh",
      }}
    />
  );
}
import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  useMap,
} from "react-leaflet";
import { geojson } from "flatgeobuf";
import L from "leaflet";

import "leaflet/dist/leaflet.css";

function ZoomToData({ data }: { data: any }) {
  const map = useMap();

  useEffect(() => {
    if (!data?.features?.length) return;

    const layer = L.geoJSON(data);
    const bounds = layer.getBounds();

    if (bounds.isValid()) {
      map.fitBounds(bounds, {
        padding: [20, 20],
      });
    }
  }, [data, map]);

  return null;
}

export default function GeoMap() {
  const [allFeatures, setAllFeatures] = useState<any[]>([]);
  const [stateFilter, setStateFilter] = useState("");

  useEffect(() => {
    async function loadFgb() {
      const response = await fetch(
        "https://flatgeobuf.org/test/data/UScounties.fgb"
      );

      const features: any[] = [];

      for await (const feature of geojson.deserialize(
        response.body!
      )) {
        features.push(feature);
      }

      console.log("Loaded:", features.length);

      console.log(
        "States:",
        [...new Set(features.map(f => f.properties.STATE))]
      );

      setAllFeatures(features);
    }

    loadFgb();
  }, []);

  const filteredFeatures = useMemo(() => {
    if (!stateFilter) {
      console.log(
        "Showing all:",
        allFeatures.length
      );
      return allFeatures;
    }

    const filtered = allFeatures.filter(
      f => f.properties?.STATE === stateFilter
    );

    console.log(
      "Filter:",
      stateFilter,
      "Count:",
      filtered.length
    );

    return filtered;
  }, [allFeatures, stateFilter]);

  const data = useMemo(
    () => ({
      type: "FeatureCollection",
      features: filteredFeatures,
    }),
    [filteredFeatures]
  );

  const states = useMemo(
    () =>
      Array.from(
        new Set(
          allFeatures
            .map(f => f.properties?.STATE)
            .filter(Boolean)
        )
      ).sort(),
    [allFeatures]
  );

  const onEachFeature = (
    feature: any,
    layer: L.Layer
  ) => {
    const p = feature.properties || {};

    layer.bindPopup(`
      <div>
        <h3>${p.NAME ?? ""}</h3>

        <table>
          <tr>
            <td><b>STATE_FIPS</b></td>
            <td>${p.STATE_FIPS ?? ""}</td>
          </tr>

          <tr>
            <td><b>COUNTY_FIP</b></td>
            <td>${p.COUNTY_FIP ?? ""}</td>
          </tr>

          <tr>
            <td><b>FIPS</b></td>
            <td>${p.FIPS ?? ""}</td>
          </tr>

          <tr>
            <td><b>STATE</b></td>
            <td>${p.STATE ?? ""}</td>
          </tr>

          <tr>
            <td><b>NAME</b></td>
            <td>${p.NAME ?? ""}</td>
          </tr>

          <tr>
            <td><b>LSAD</b></td>
            <td>${p.LSAD ?? ""}</td>
          </tr>
        </table>
      </div>
    `);

    layer.on({
      mouseover: (e: any) => {
        e.target.setStyle({
          weight: 3,
          color: "#0066ff",
          fillOpacity: 0.5,
        });
      },

      mouseout: (e: any) => {
        e.target.setStyle({
          weight: 1,
          color: "#ff0000",
          fillOpacity: 0.2,
        });
      },
    });
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 1000,
          top: 10,
          left: 60,
          background: "white",
          padding: 10,
          borderRadius: 6,
        }}
      >
        <select
          value={stateFilter}
          onChange={(e) =>
            setStateFilter(e.target.value)
          }
        >
          <option value="">
            All States
          </option>

          {states.map((state) => (
            <option
              key={state}
              value={state}
            >
              {state}
            </option>
          ))}
        </select>
      </div>

      <MapContainer
        center={[39, -98]}
        zoom={4}
        style={{
          width: "100%",
          height: "100%",
        }}
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap"
        />

        <ZoomToData data={data} />

        <GeoJSON
          key={`${stateFilter}-${filteredFeatures.length}`}
          data={data as any}
          onEachFeature={onEachFeature}
          style={{
            color: "red",
            weight: 1,
            fillOpacity: 0.2,
          }}
        />
      </MapContainer>
    </div>
  );
}
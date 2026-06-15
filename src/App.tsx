import { useState } from 'react'
import './App.css'
import GeoMap from './GeoMap'
import PMTilesMap from './PMTilesMap'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
    <GeoMap/>
  <PMTilesMap/>
    </>
  )
}

export default App

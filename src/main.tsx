import React, { StrictMode } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

window.React = React
window.ReactDOM = ReactDOM

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

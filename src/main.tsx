/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom'
import './index.css'
import Home from './pages/Home'
import Settings from './pages/Settings'
import SpikePage from './pages/SpikePage'
import { registerSW } from 'virtual:pwa-register'

registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <nav className="topnav">
        <NavLink to="/" end>首页</NavLink>
        <NavLink to="/settings">设置</NavLink>
        <NavLink to="/spike">Spike 测试</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/spike" element={<SpikePage />} />
      </Routes>
    </HashRouter>
  </StrictMode>,
)

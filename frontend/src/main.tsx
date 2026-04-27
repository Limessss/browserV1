import { installDevWailsShims } from './shims/install-dev-wails'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

installDevWailsShims()

;(window as Window & { __ANT_APP_BOOTED__?: boolean }).__ANT_APP_BOOTED__ = true

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)


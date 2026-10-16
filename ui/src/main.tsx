import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import './styles.css'
import './control-room.css'
import './workbench.css'
import './identity.css'

createRoot(document.getElementById('root')!).render(<App />)

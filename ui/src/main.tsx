import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { applyAccent, applyDensity, applyFont, savedAccent, savedDensity, savedFont } from './theme'
import './fonts.css'
import './tokens.css'
import './styles.css'
import './control-room.css'
import './workbench.css'
import './identity.css'
import './luxe.css'
import './bridge.css'

applyFont(savedFont())
applyAccent(savedAccent())
applyDensity(savedDensity())
createRoot(document.getElementById('root')!).render(<App />)

# Companion Module Spec

Stand: 2026-05-14

Dieses Dokument ist die saubere Übergabe für die Umsetzung eines Bitfocus-Companion-Moduls gegen VideoHubSim.

## Ziel

Companion soll VideoHubSim von außen identisch steuern können, unabhängig davon, ob die App gerade im Simulator-Modus oder im Controller-Modus arbeitet.

Benötigt werden:

- Direktes Routing wie `1:15`, `01:15` oder `099:155`
- Salvos auslösen
- Aktuellen Status pro Output als Feedback in Companion sehen
- Feedback, ob ein Salvo aktuell aktiv ist
- Salvo-Liste dynamisch laden und bei Änderungen aktualisieren
- Optional: einen neuen Salvo aus dem aktuellen Zustand erzeugen, der alle Outputs enthält

Nicht benötigt:

- Fernsteuerung allgemeiner App-Settings
- Separater Feedback-Port
- UDP-basierte Sonderlösung

## Architekturentscheidung

Empfehlung für Phase 1:

- Ein einziger lokaler HTTP-Port in der App
- Actions und Listenabrufe per HTTP
- Live-Feedback per SSE auf demselben Port

Warum das sinnvoll ist:

- Keine zweite Port-Konfiguration für Feedback nötig
- Companion verbindet sich als Client zur App, daher braucht die App keinen Ziel-Port für Feedback zu kennen
- HTTP ist für Actions, Config und Dropdowns unkompliziert
- SSE ist für einseitige Live-Updates ausreichend und deutlich einfacher als eine volle bidirektionale WebSocket-Schicht
- Die App hat diese Richtung bereits begonnen; dadurch ist der Implementierungsaufwand kleiner als ein Wechsel auf UDP oder ein kompletter WebSocket-Umbau

Nicht empfohlen für Phase 1:

- UDP: unnötig fehleranfällig, keine verlässliche Zustandskopplung
- Separater Feedback-Port: unnötige Konfiguration, Companion ist ohnehin der Client

WebSocket wäre technisch auch möglich, ist hier aber nicht nötig. Wenn später eine bidirektionale Sitzung gebraucht wird, kann von HTTP+SSE immer noch auf HTTP+WebSocket erweitert werden.

## Port- und Verbindungsmodell

App-seitig sinnvoll:

- UI-Gruppe `Companion`
- Feld `Companion Port`
- Standardport zunächst `9123`
- Optional später: `Bind Address`
- Optional später: `Auth Token`

Nicht einbauen:

- Kein Feld `Feedback Port`
- Kein Feld `Companion IP`

Modul-seitig sinnvoll:

- Host
- Port
- Optional Token

## Keepalive

Für Phase 1 kein eigener Keepalive-Befehl von Companion nötig.

Empfehlung:

- Companion hält eine dauerhafte SSE-Verbindung auf `/api/events`
- Wenn die Verbindung abreißt, reconnectet das Modul automatisch
- Optional kann das Modul zusätzlich periodisch `/api/health` pollen, z. B. alle 10 Sekunden, um den Verbindungsstatus robuster zu erkennen
- Die App sendet jetzt zusätzlich alle 15 Sekunden ein SSE-Event `heartbeat`

## Bereits vorhanden

Bereits implementiert in VideoHubSim:

- `GET /api/health`
- `GET /api/state`
- `GET /api/choices`
- `GET /api/salvos`
- `GET /api/events`
- `POST /api/route`
- `POST /api/salvos/:id/recall`
- `POST /api/salvos/capture`
- Renderer-UI für `Companion Port` und `Enable Companion API`
- Renderer-/IPC-Status für Companion-API
- Renderer-/IPC-Event `salvos-changed`
- SSE-Event `heartbeat` im 15-Sekunden-Takt

Bereits wichtig für Companion:

- `POST /api/route` akzeptiert bereits menschenlesbare 1-basige Nummern
- State enthält `matchingSalvos`
- Choices enthält Inputs, Outputs, Levels und Salvos
- SSE liefert beim Connect Initialzustand

Zusätzlich bereits geprüft:

- Externes Capture eines Salvos über alle Outputs funktioniert
- Neu erzeugte Salvos erscheinen in `GET /api/salvos`
- Ein frisch gecaptureter Salvo taucht korrekt in `state.matchingSalvos` auf, wenn der aktuelle Zustand passt

## Noch zu ergänzen in der App

Diese App-Erweiterungen werden für das Modul noch benötigt oder stark empfohlen.

### 1. Companion-Port im UI einstellbar machen

Status: erledigt

Umgesetzt:

- Lokales App-Setting `externalControl.port`
- UI-Feld unter einer Überschrift `Companion`
- Toggle `Enable Companion API`
- Validierung für Portnummern

Nicht nötig:

- Kein gesondertes Feedback-Port-Feld

### 2. Salvo-Änderungen als Live-Event senden

Status: erledigt

Aktuell bekommt der Client bei `/api/events` den initialen Salvo-Stand, aber Änderungen an Salvos sollten zusätzlich live ausgesendet werden.

Umgesetzt:

- Event `salvos-changed`
- Auslösen nach:
  - Save Salvo
  - Duplicate Salvo
  - Delete Salvo
  - Import Salvos
  - Capture Salvo
  - Reorder Salvos
  - Route-Änderungen nur dann, wenn `matchingSalvos` neu berechnet werden soll

Empfohlene Payload:

```json
{
  "salvos": [
    {
      "id": "salvo_123",
      "name": "Example",
      "routeCount": 12,
      "protocol": "videohub",
      "source": "simulator",
      "color": null
    }
  ],
  "matchingSalvos": [
    {
      "id": "salvo_123",
      "name": "Example",
      "color": null
    }
  ]
}
```

### 3. Externes Capturen eines Salvos aus aktuellem Status

Status: erledigt

Gewünscht ist das Anlegen eines neuen Salvos aus dem aktuellen Zustand, wobei alle Outputs eingeschlossen werden.

Umgesetzt:

- Neuer Endpunkt `POST /api/salvos/capture`

Vorschlag Request:

```json
{
  "name": "My Companion Salvo",
  "target": "active",
  "includeAllOutputs": true,
  "level": "all"
}
```

Vorschlag Verhalten:

- `target` standardmäßig `active`
- `includeAllOutputs: true` nimmt alle Outputs auf
- `level: "all"` für Multi-Level-Protokolle alle Levels, sonst Level 1
- Rückgabe enthält den neuen Salvo und die aktualisierte Salvo-Liste

### 4. Route-String Parsing nicht in der App, sondern im Modul

Status: bleibt Modul-Aufgabe

Die App muss keinen zusätzlichen Endpunkt für Strings wie `001:015` bekommen.

Empfehlung:

- Das Companion-Modul parst den Benutzereingabewert
- Zulässig sind Formate wie `1:15`, `01:15`, `099:155`
- Führende Nullen werden ignoriert
- Danach wird normal `POST /api/route` mit numerischen Werten aufgerufen

## Modul-Verhalten

### Verbindung

- Das Modul verbindet sich per HTTP zur App
- Für Live-Feedback öffnet das Modul zusätzlich eine SSE-Verbindung zu `/api/events`
- Das Modul arbeitet standardmäßig gegen `target=active`

Wichtig:

- Das Modul soll Simulator/Controller nicht doppelt modellieren
- Die App entscheidet selbst, was `active` bedeutet

### Actions

Minimum für Version 1:

- `Recall Salvo`
- `Set Route`
- `Set Route From String`
- `Capture Salvo From Current State`

Empfohlene Action-Details:

#### Recall Salvo

- Dropdown mit aktueller Salvo-Liste
- Sendet `POST /api/salvos/:id/recall`

#### Set Route

- Dropdown `Output`
- Dropdown `Input`
- Optional Dropdown `Level` für Multi-Level
- Sendet `POST /api/route`

#### Set Route From String

- Textfeld für Eingaben wie `1:15`, `01:15`, `099:155`
- Parser im Modul
- Bei Fehler klare Validierungsmeldung

Parsing-Regel:

- Regex-Vorschlag: `^\s*(\d+)\s*:\s*(\d+)\s*$`
- Beide Seiten mit `parseInt(..., 10)`
- Werte müssen `>= 1` sein
- Routing-Anzeigen und Routing-Feedbacks immer nur als `output:input` mit Nummern darstellen, nie mit Labels mischen

#### Capture Salvo From Current State

- Textfeld `Name`
- Optional Checkbox `Include all outputs`, standardmäßig aktiv
- Sendet `POST /api/salvos/capture`

### Dropdowns

Dropdowns sollen aus `/api/choices` befüllt werden.

Benötigt:

- Inputs
- Outputs
- Levels
- Salvos

Die Dropdowns müssen bei `salvos-changed` und bei Reconnect aktualisiert werden.

### Feedbacks

Benötigte Feedbacks in Companion:

#### 1. Route Active

Frage: Ist auf Output X aktuell Input Y geroutet?

Quelle:

- `state.crosspoints`

Beispiel:

- Feedback aktiv, wenn `outputNumber === 1` und `inputNumber === 15`
- Für sichtbare Routing-Texte im Modul nur numerische Formate wie `1:15` oder `001:015` verwenden

#### 2. Output Current Input

Frage: Welcher Input liegt aktuell auf Output X?

Quelle:

- `choices.outputs[].currentInput`
- oder `state.crosspoints`

Verwendung:

- Text-Variable oder Feedback-Zustand für Companion-Buttons

#### 3. Salvo Exists

Frage: Gibt es den gewählten Salvo noch?

Quelle:

- aktuelle Salvo-Liste

#### 4. Salvo Active

Frage: Entspricht der aktuelle Routerzustand exakt diesem Salvo?

Quelle:

- `state.matchingSalvos`

Wichtig:

- `aktiv` bedeutet exakter Match gegen die im Salvo gespeicherten Routen
- Nicht `zuletzt getriggert`

Das ist das richtige Feedback für Companion, weil es den realen Zustand abbildet.

### Variablen

Empfohlen:

- `output_001_input_number`
- `output_001_route`
- `active_salvos`
- `connection_state`

Formatierung:

- Output-Nummern mit Padding im Modul erzeugen, z. B. `001`, `099`
- Route-Variablen nur numerisch formatieren, z. B. `001:015`
- Intern bleibt die API numerisch

## Companion-Presets

Empfohlen für das Modul:

- Presets für `Recall Salvo`
- Presets für `Set Route` mit Dropdowns
- Optional generierte Presets pro Output x Input nicht standardmäßig, da das bei großen Matrizen schnell explodiert

Sinnvoller ist:

- universelle Action-Buttons mit Dropdowns
- plus Salvo-Presets

## App-UI-Anforderung

In VideoHubSim soll lokal eine kleine Gruppe `Companion` sichtbar sein.

Minimum:

- `Companion Port`

Optional:

- `Enable Companion API`
- `Auth Token`
- Statusanzeige `Companion API listening on port ...`

Nicht nötig:

- Kein Feedback-Port-Feld
- Kein Zielhost-Feld für Companion

## Technische Aufgaben für Codex CLI

### App-Seite

Bereits erledigt in dieser Workspace-Session:

1. Companion-Port im UI konfigurierbar und auf `externalControl.port` gespeichert.
2. Companion-API-Status in der UI sichtbar.
3. Endpunkt `POST /api/salvos/capture` vorhanden.
4. Event `salvos-changed` vorhanden und bei Salvo-Mutationen verdrahtet.

Optional noch offen:

1. Optional Token-Feld im UI ergänzen.
2. Optional Bind-Address im UI ergänzen.

### Modul-Seite

1. Neues Companion-Modul anlegen.
2. Config-Felder: Host, Port, optional Token.
3. HTTP-Client für Actions und Choices.
4. SSE-Client für Live-Status und Reconnect.
5. Actions implementieren:
   - Recall Salvo
   - Set Route
   - Set Route From String
   - Capture Salvo From Current State
6. Feedbacks implementieren:
   - Route Active
   - Output Current Input
   - Salvo Exists
   - Salvo Active
   - Connection State
7. Variablen pro Output pflegen.
8. Salvo-Dropdown dynamisch aktualisieren.

## Testplan

### App-API

1. `GET /api/health`
2. `GET /api/state`
3. `GET /api/choices`
4. `POST /api/route` mit `1:15`-Semantik
5. `POST /api/salvos/:id/recall`
6. `POST /api/salvos/capture`
7. SSE-Reconnect nach App-Neustart
8. `salvos-changed` nach Save/Delete/Capture

Bereits verifiziert in dieser Session:

1. `GET /api/health`
2. `GET /api/state`
3. `GET /api/choices`
4. `POST /api/route` mit `1:15`-Semantik
5. `POST /api/salvos/:id/recall`
6. `POST /api/salvos/capture`
7. `GET /api/salvos` nach Capture

Noch sinnvoll zu prüfen:

1. `salvos-changed` mit einem echten SSE-Listener über mehrere Mutationen hinweg
2. SSE-Heartbeat mit einem echten Listener über mindestens 15 Sekunden
3. UI-Statusanzeige für Companion-Port/Enable manuell in der App
4. Controller-Modus mit `target=active`

### Modul

1. Verbindung zur laufenden App herstellen
2. Dropdowns laden
3. Route per Dropdown setzen
4. Route per String setzen mit `1:15`
5. Route per String setzen mit führenden Nullen, z. B. `001:015`
6. Salvo recallen
7. Neuen Salvo capturen
8. Prüfen, dass neue Salvos ohne Companion-Neustart im Dropdown erscheinen
9. Feedback `Salvo Active` prüfen
10. Feedback pro Output prüfen

### Negative Tests

1. Ungültige Route-Strings
2. Output/Input außerhalb der Matrixgröße
3. Fehlender Salvo
4. API nicht erreichbar
5. SSE-Verbindung fällt weg
6. Token falsch

## Offene Annahmen

Diese Annahmen sollen für die Umsetzung gelten, wenn nichts anderes entschieden wird:

- Das Modul arbeitet standardmäßig immer gegen `target=active`
- `Salvo Active` bedeutet exakter Match, nicht zuletzt ausgelöst
- Ein einzelner Companion-Port in der App reicht aus
- HTTP+SSE bleibt die Basis für Version 1
- Route-String Parsing passiert im Modul, nicht in der App

## Aktuelle Testgrenze

Der Controller-Modus ist derzeit nicht end-to-end verifiziert, weil in dieser Session kein echter externer Router beziehungsweise Hardware-Hub angeschlossen ist.

Für Codex bedeutet das:

- `target=active` im Controller-Modus erst gegen echte Hardware oder einen erreichbaren Test-Router validieren
- Die bisherige Verifikation deckt Simulator-Modus und die app-eigene API-Schicht ab

## Was der Nutzer explizit wollte

- Keine allgemeine Settings-Fernsteuerung
- Direkte Routings und Salvo-Trigger sind Pflicht
- Führende Nullen in Routing-Strings sollen egal sein
- Feedback für Salvo-Status und für aktuelle Input-Zuordnung pro Output ist Pflicht
- Salvos sollen extern erzeugbar sein
- Salvo-Liste soll sich live aktualisieren
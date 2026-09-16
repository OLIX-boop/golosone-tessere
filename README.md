# Tessere punti

Raccolta punti per pasticceria. L'operatore assegna i punti a mano dalla cassa.
Nessuna scansione di scontrini, nessun importo registrato.

## Come e messo insieme

Tre superfici, un solo dato condiviso:

| Cosa | Dove | Chi la usa |
|---|---|---|
| Pannello cassa | `/` | operatore, nel browser del PC cassa |
| Pagina cliente | `/c/CODICE` | chiunque abbia il link, sola lettura |
| API | `/api/*` | le due sopra |

Il **QR sulla tessera contiene l'URL della pagina cliente**, e serve a due cose
con lo stesso identico codice:

- il cliente lo inquadra col telefono e finisce sul suo saldo;
- l'operatore lo scansiona col lettore in cassa, e il pannello estrae il codice
  scartando il resto dell'URL.

## Decisioni che conviene non ribaltare a cuor leggero

### Si registrano punti, non importi

L'operatore guarda lo scontrino, decide quanti punti vale e li assegna. Due
conseguenze volute:

- **niente prezzo scritto da contestare.** Se chi e' di fretta sbaglia a
  digitare, non resta un importo sbagliato che il cliente vede sulla sua pagina
  e viene a discutere al banco;
- **le spese minime non lasciano residui.** Cinque scontrini da un euro non
  accumulano un punto: quelle vendite si portano dietro costi fissi (tempo alla
  cassa, commissione POS, incarto) e il margine non c'e'.

Il prezzo di questa scelta: **i punti non sono ricalcolabili da nient'altro**,
sono loro il dato. Se un numero e' sbagliato non c'e' modo di dedurre quello
giusto. Per questo esistono il tetto per movimento e l'annullo.

### Un solo PIN, condiviso

Il pannello si apre dalla cassa e resta aperto (sessione da 30 giorni). Non c'e'
un account per persona: autenticare ogni operatore sarebbe attrito senza
guadagno, visto che nessuno usa il proprio telefono.

Conseguenza: **i movimenti non portano il nome di chi li ha fatti.** Contro
l'errore restano il tetto per movimento e la finestra di annullo; contro chi
prova a entrare, il blocco progressivo.

Il blocco dopo 8 tentativi falliti riguarda **solo i nuovi accessi**: una cassa
gia' sbloccata continua a lavorare, quindi nessuno puo' fermarti il negozio
sbagliando PIN da fuori.

### L'alfabeto dei codici esclude i caratteri ambigui

Esclusi `0 O 1 I L S U V`. Serve a due scopi: il cliente puo' dettare il codice
al telefono senza equivoci, e un lettore barcode con il layout di tastiera
sbagliato non puo' produrre un codice valido ma diverso.

Per la stessa ragione il codice digitato **non viene mai "corretto" indovinando**:
una correzione sbagliata assegnerebbe i punti a un altro cliente senza che
nessuno se ne accorga.

### Il registro spiega il saldo, non fa da scontrino

`transactions` e' append-only: un errore si annulla (`voided_at`), non si
cancella. Serve a capire come si e' arrivati a un saldo, non a certificare
acquisti.

### Il QR da sola lettura

Chi conosce il link vede il saldo e basta. Assegnare punti passa da rotte che
richiedono la sessione. Per questo la pagina cliente mostra solo il nome di
battesimo: niente cognome, telefono o email.

## Sviluppo

```bash
npm install
npm run db:local   # crea lo schema in locale
npm run db:seed    # il premio
npm run dev        # http://127.0.0.1:8787
```

Al primo avvio il pannello chiede di scegliere il PIN del negozio.

```bash
npm test           # validazione punti e parsing codici
npm run typecheck
```

## Messa in produzione

```bash
npx wrangler d1 create tessere        # copia l'id in wrangler.jsonc
npm run db:remote                     # schema sul database vero
npx wrangler deploy
```

## Parametri

Si cambiano in `settings` senza rideploy:

| Chiave | Default | Cosa fa |
|---|---|---|
| `store_name` | `Pasticceria` | nome mostrato ovunque |
| `max_points_per_tx` | `20` | tetto anti-errore: il 2 che diventa 22 |
| `void_window_min` | `30` | minuti entro cui annullare un movimento |
| `show_rewards_to_customer` | `1` | `0` lascia al cliente il solo saldo punti |

```bash
npx wrangler d1 execute tessere --local --command "UPDATE settings SET value='15' WHERE key='max_points_per_tx'"
```

Il PIN sta in `settings` come hash: per cambiarlo si cancellano
`access_pin_hash` e `access_pin_salt` e il pannello richiede il primo avvio.

## Premi

Per ora ce n'e' uno solo, la **Tortina a 20 punti**, ma vive in tabella e non nel
codice: cambiarne nome o soglia, o aggiungerne altri, non richiede un rideploy.

```bash
npx wrangler d1 execute tessere --local --command "UPDATE rewards SET points_cost=25 WHERE name='Tortina'"
```

La pagina cliente mostra il traguardo ("13 punti alla Tortina") perche' e' il
motivo per cui un cliente riapre quella pagina. Se preferisci lasciare solo il
saldo, visto che il premio si ritira comunque in negozio:

```bash
npx wrangler d1 execute tessere --local --command "UPDATE settings SET value='0' WHERE key='show_rewards_to_customer'"
```

## Da fare

- [ ] Pannello titolare: premio, PIN, report di giornata
- [ ] Stampa tessere: PDF con QR e codice in chiaro
- [ ] Pulsante "Aggiungi a Google Wallet" (pass dinamico, gratuito)
- [ ] Istruzioni in-negozio per il pass Apple Wallet (iOS 27, statico)

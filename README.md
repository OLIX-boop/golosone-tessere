# Tessere punti

Raccolta punti per pasticceria. Un punto ogni 5 EUR di spesa, assegnati a mano
dalla cassa. Nessuna scansione di scontrini.

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

### Decisioni che conviene non ribaltare a cuor leggero

**I centesimi che avanzano non si buttano.** Una spesa da 12 EUR da 2 punti e
lascia 2 EUR sul conto del cliente (`customers.cents_carry`), che si sommano
all'acquisto dopo. E il motivo per cui il saldo non si ricalcola dal totale
speso.

**Gli importi sono interi in centesimi, mai numeri decimali.** `parseAmountToCents`
rifiuta quello che non sa convertire invece di arrotondare a caso.

**L'alfabeto dei codici tessera esclude i caratteri ambigui** (`0 O 1 I L S U V`).
Serve a due scopi: il cliente puo' dettare il codice al telefono senza equivoci,
e un lettore barcode con il layout di tastiera sbagliato non puo' produrre un
codice valido ma diverso. Per la stessa ragione il codice digitato **non viene
mai "corretto" indovinando**: una correzione sbagliata assegnerebbe i punti a un
altro cliente senza che nessuno se ne accorga.

**Il registro `transactions` e la fonte di verita'.** I saldi su `customers`
sono una cache ricalcolabile. Un errore si annulla (`voided_at`), non si
cancella: si deve sempre poter vedere chi ha fatto cosa.

**Il QR da solo lettura.** Chi conosce il link vede il saldo e basta. Assegnare
punti passa da rotte che richiedono la sessione operatore. Per questo la pagina
cliente mostra solo il nome di battesimo: niente cognome, telefono o email.

## Sviluppo

```bash
npm install
npm run db:local   # crea lo schema in locale
npm run db:seed    # premi di esempio
npm run dev        # http://127.0.0.1:8787
```

Al primo avvio il pannello chiede di creare l'account del titolare.

```bash
npm test           # logica punti e parsing codici
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
| `cents_per_point` | `500` | 5 EUR = 1 punto |
| `store_name` | `Pasticceria` | nome mostrato ovunque |
| `void_window_min` | `15` | minuti entro cui la cassa puo' annullare |
| `max_amount_cents` | `50000` | tetto anti-errore di battitura (500 EUR) |
| `show_rewards_to_customer` | `1` | `0` lascia al cliente il solo saldo punti |

```bash
npx wrangler d1 execute tessere --local \
  --command "UPDATE settings SET value='400' WHERE key='cents_per_point'"
```

## Premi

Per ora ce n'e' uno solo, la **Tortina a 20 punti**, ma vive in tabella e non nel
codice: cambiarne nome o soglia, o aggiungerne altri, non richiede un rideploy.

```bash
# cambiare la soglia
npx wrangler d1 execute tessere --local   --command "UPDATE rewards SET points_cost=25 WHERE name='Tortina'"
```

20 punti valgono **100 EUR di spesa**: vale la pena confrontarlo col margine
reale della tortina prima di stampare le tessere, perche' dopo la soglia si
alza malvolentieri.

La pagina cliente mostra il traguardo ("9 punti alla Tortina") perche' e' il
motivo per cui un cliente riapre quella pagina. Se preferisci lasciare solo il
saldo, visto che il premio si ritira comunque in negozio:

```bash
npx wrangler d1 execute tessere --local   --command "UPDATE settings SET value='0' WHERE key='show_rewards_to_customer'"
```

## Da fare

- [ ] Pannello titolare: premi, operatori, report di giornata
- [ ] Stampa tessere: PDF con QR e codice in chiaro
- [ ] Pulsante "Aggiungi a Google Wallet" (pass dinamico, gratuito)
- [ ] Istruzioni in-negozio per il pass Apple Wallet (iOS 27, statico)

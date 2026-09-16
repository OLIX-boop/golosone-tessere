# Tessere punti

Raccolta punti per pasticceria. L'operatore assegna i punti a mano dalla cassa.
Nessuna scansione di scontrini, nessun importo registrato.

## Come e messo insieme

Tre superfici, un solo dato condiviso:

| Cosa | Dove | Chi la usa |
|---|---|---|
| Pannello cassa | `/` | operatore, nel browser del PC cassa |
| Pannello titolare | `/titolare` | titolare, con un PIN proprio |
| Salva nel telefono | `/c/CODICE/wallet` | il cliente, da Android |
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

### Il titolare ha un PIN suo

Il PIN di cassa e' condiviso da chi sta al banco. Se il pannello titolare stesse
dietro lo stesso PIN, chiunque potrebbe alzare la soglia del premio o leggere
gli andamenti: quindi ne ha uno separato.

Non introduce l'attrito che avevamo scartato per la cassa, perche' si usa di
rado e mai in mezzo alla fila. La sessione dura 4 ore invece di 30 giorni: si
entra, si guarda, si esce.

Il primo PIN titolare si puo' impostare **solo da una cassa gia' sbloccata**,
altrimenti il primo che trova l'indirizzo se lo prenderebbe.

Cambiare il PIN di cassa dal pannello titolare **chiude tutte le sessioni di
cassa aperte**: senza quello, cambiarlo non servirebbe a niente.

### Le tessere esistono prima dei clienti

Non si puo' stampare un cartoncino mentre il cliente aspetta al banco. Quindi le
tessere si stampano in lotti, restano in una scatola alla cassa, e si attivano
al momento della consegna: si scansiona la tessera vergine, si scrive il nome,
fatto.

Finche' non e' consegnata, una tessera ha `first_name` e `activated_at` a NULL.
Non puo' ricevere punti (scansionare il cartoncino sbagliato dalla scatola non
deve regalare niente a nessuno) e non compare nelle ricerche per nome o
telefono.

Il campo `batch` raggruppa le tessere stampate insieme, cosi' un foglio
rovinato si ristampa senza generare codici nuovi e senza sprecare quelli gia'
stampati.

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

## Stampare le tessere

Dal pannello cassa, riquadro "Tessere da stampare": scegli quante e premi
**Crea lotto**. Si apre il foglio pronto, `Stampa` manda al browser.

Dieci tessere per foglio A4, formato biglietto da visita (85x55mm). Le misure
sono in millimetri e non in pixel: e' l'unica unita' che il browser traduce
fedelmente in stampa a prescindere da zoom e DPI, e il taglio deve tornare.

Consigliato cartoncino da 250-300 g/m2.

Il QR contiene l'indirizzo della pagina cliente e viene costruito
**dall'origine della richiesta**: il foglio stampato in locale punta a
localhost, quello stampato in produzione al dominio vero. Non c'e' niente da
configurare, ma significa anche che **le tessere vanno stampate dal dominio
definitivo**, altrimenti i QR puntano a un indirizzo che non esiste piu'.

Sotto ogni QR c'e' il codice in chiaro: salva la giornata quando il lettore non
legge, lo schermo e' crepato, o il cliente detta il codice al telefono.

## Pannello titolare

`/titolare`, PIN separato. Quattro schede:

- **Andamento** - punti, clienti serviti e tessere consegnate di oggi, con il
  grafico degli ultimi 7/14/30 giorni e una vista tabellare degli stessi dati.
  I giorni si raggruppano nel fuso del negozio (`timezone`, default
  `Europe/Rome`) e non in UTC: altrimenti la giornata si spezzerebbe alle 2 del
  mattino, e d'estate alle 3.
- **Premi** - nome e soglia, attiva/disattiva. Un premio non si cancella mai:
  disattivarlo lo toglie dalla cassa ma tiene in piedi i movimenti che lo
  citano.
- **Clienti** - i 15 con piu' punti, ricerca per nome/telefono/codice, e il
  blocco di una tessera persa o clonata. Bloccare non cancella: i punti restano
  e il registro pure, ma la tessera non e' piu' utilizzabile.
- **Impostazioni** - nome negozio, tetto punti, finestra di annullo, traguardo
  visibile al cliente, e il cambio del PIN di cassa.

Il POST delle impostazioni scrive **solo una lista chiusa di chiavi**: senza
quel filtro basterebbe una richiesta con `access_pin_hash` per scavalcare il
PIN.

## La tessera nel telefono

I due sistemi sono asimmetrici, e conviene saperlo prima di promettere cose ai
clienti.

### Google Wallet - dinamico, gratuito, da configurare

**Prima serve il deploy.** Su `localhost` non puo' funzionare: il link firmato
dichiara a Google da quale dominio arriva, e un indirizzo locale Google non lo
raggiunge. Quindi l'ordine e': prima in produzione, poi Wallet.

Il pass sta nel Wallet del telefono e **il saldo si aggiorna da solo**: quando
la cassa assegna i punti, il server riallinea il pass in sottofondo.

Servono due pezzi:

**1. La chiave del service account**, come segreto del Worker. Mai in database:
un dump del database non deve consegnare anche la facolta' di emettere tessere
a nome del negozio.

```bash
npm run wallet:chiave -- "C:/Users/andre/Downloads/service-account.json"
```

Lo script legge il file, controlla che sia davvero un account di servizio -
meglio accorgersene subito che davanti a un errore di Google tre passaggi dopo -
e lo carica codificato in base64. Il base64 non e' un vezzo: quel JSON contiene
una chiave PEM su piu' righe, e passarla cruda a una variabile d'ambiente e' un
invito a rovinarla.

**2. L'ID emittente**, dalla console Google Pay & Wallet. Si incolla nel
pannello titolare, scheda Impostazioni, riquadro Google Wallet.

Finche' manca un pezzo il pulsante non compare e il resto funziona come prima;
il pannello titolare dice quale dei due manca.

Da sapere prima di partire: l'account emittente nasce in **modalita' demo** e
puo' emettere pass solo verso account di prova. Per i clienti veri serve
chiedere l'accesso alla pubblicazione - gratuito, ma con qualche giorno di
attesa, quindi conviene avviare la richiesta presto.

### Apple Wallet - statico, gratuito, niente da programmare

Da iOS 27 chiunque puo' creare un pass senza sviluppatore e senza certificato,
ma la funzione e' **avviata solo dall'utente sul telefono**: nessun sito puo'
innescarla, e il pass resta congelato al momento in cui viene creato.

Per questo qui non c'e' integrazione ma istruzioni sulla pagina cliente. Un
dettaglio che non si puo' sbagliare: dicono di inquadrare **il cartoncino**, non
lo schermo, perche' nessuno puo' inquadrare il proprio telefono col proprio
telefono.

Il pass su iPhone serve quindi a ritrovare il codice, non a leggere il saldo:
per quello il cliente torna sulla pagina.

I 99 euro l'anno dell'Apple Developer Program comprerebbero il saldo che si
aggiorna e il pulsante sul sito. Per una pasticceria che parte non valgono;
l'architettura non cambia se un giorno li si volesse spendere.

### Se Google non risponde

L'aggiornamento del pass parte in sottofondo e ingoia ogni errore: la cassa non
deve fermarsi perche' Google e' giu'. Misurato con credenziali non valide, la
cassa risponde in **44 millisecondi** e i fallimenti restano nei log. Nel
peggiore dei casi il pass resta indietro finche' il cliente non riapre la sua
pagina.

### Il logo e obbligatorio

Google rifiuta la classe senza logo: *"LoyaltyClass cannot be created without a
program logo"*. L'immagine deve stare su un indirizzo HTTPS pubblico, quindi la
serve il Worker stesso da `public/logo.png`.

Quello attuale e' un segnaposto generato. Per metterci il logo vero basta
sostituire il file con un PNG quadrato di almeno 660x660, **sfondo pieno e non
trasparente** perche' Google lo mostra su fondi di colore variabile. Per
rigenerare il segnaposto dopo aver cambiato i colori:

```bash
npm run logo
```

Il logo cambia solo alla creazione della classe. Se lo sostituisci dopo,
la classe esistente va aggiornata a mano dalla console Google.

## Da fare

- [ ] Ristampa di un lotto, marcando le tessere sostituite
- [ ] Chiedere a Google l'accesso alla pubblicazione (finche' l'emittente e'
      in modalita' demo, i pass funzionano solo per gli account di prova)

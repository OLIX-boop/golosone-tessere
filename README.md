# Tessere punti

Raccolta punti per pasticceria. L'operatore assegna i punti a mano dalla cassa.
Nessuna scansione di scontrini, nessun importo registrato.

**In produzione** su Cloudflare Workers. Tutto sta dentro un solo Worker:
TypeScript con [Hono](https://hono.dev/) per le rotte, [D1](https://developers.cloudflare.com/d1/)
(SQLite) per i dati, i file statici serviti dalla CDN, e l'integrazione con
Google Wallet e Apple Wallet per la tessera nel telefono. Nessun server da
amministrare e nessun costo fisso: l'unica spesa e' l'account sviluppatore
Apple, senza il quale il pass su iPhone non si puo' firmare.

## Struttura

| Percorso | Cosa c'e' dentro |
|---|---|
| `src/index.ts` | Rotte HTTP: pannello, API, pagina cliente, foglio di stampa |
| `src/auth.ts` | PIN, sessioni, blocco progressivo dopo i tentativi falliti |
| `src/points.ts` | Assegnazione punti, tetto per movimento, annullo |
| `src/codes.ts` | Alfabeto dei codici, generazione, parsing di quel che arriva dal lettore |
| `src/qr.ts` | QR della tessera, costruito dall'origine della richiesta |
| `src/db.ts` | Query D1 |
| `src/google-wallet.ts` | Classe e oggetto del pass, firma JWT, riallineamento del saldo |
| `src/apple-wallet.ts` | Costruzione del `.pkpass`, manifesto, token dei pass |
| `src/pkcs7.ts` | Firma CMS del manifesto, scritta a mano |
| `src/zip.ts` | Archivio ZIP: un `.pkpass` e' uno ZIP |
| `src/apns.ts` | Notifica che sveglia i pass Apple |
| `src/apple-wwdr.ts` | Intermedio Apple, pubblico: sta qui per non pesare sul segreto |
| `migrations/` | Schema: `0001` tabelle, `0002` premio iniziale, `0003` sessione titolare, `0004` pass Apple |
| `public/` | Pannello cassa, pannello titolare, CSS, logo e icona serviti ai due Wallet |
| `public/tema.css` | La tavolozza, in un posto solo: la caricano tutte e tre le superfici |
| `assets/` | L'originale del logo: non viene servito, e' la sorgente delle immagini |
| `scripts/` | Caricamento delle chiavi Wallet, immagini per i due Wallet |
| `test/` | Test su punti, codici, autenticazione e pass |

## Come e messo insieme

Superfici diverse, un solo dato condiviso:

| Cosa | Dove | Chi la usa |
|---|---|---|
| Pannello cassa | `/` | operatore, nel browser del PC cassa |
| Pannello titolare | `/titolare` | titolare, con un PIN proprio |
| Salva nel telefono | `/c/CODICE/wallet` | il cliente, da Android |
| Salva nel telefono | `/c/CODICE/apple` | il cliente, da iPhone |
| Pagina cliente | `/c/CODICE` | chiunque abbia il link, sola lettura |
| Attivazione | `/c/CODICE` | il cliente, se la tessera e' ancora vergine |
| Aggiornamento pass | `/wallet-apple/v1/*` | l'iPhone del cliente, non una persona |
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
al momento della consegna.

**Ad attivarle e' il cliente, dal proprio telefono.** L'operatore consegna il
cartoncino e basta: chi lo riceve inquadra il QR e trova un modulo al posto del
saldo. Il nome lo scrive chi lo conosce meglio, sulla propria tastiera.

Il motivo e' pratico: **la cassa non ha una tastiera**, e scrivere un nome col
cliente davanti e la fila dietro e' il momento peggiore per digitare. Il
modulo chiede il minimo: il nome. Il telefono e' facoltativo, serve solo a
ritrovare la tessera quando il cliente la dimentica, e lo dice invece di
raccoglierlo in silenzio.

L'intestazione dalla cassa **resta**, per chi non ha uno smartphone o non se
la cava: e' la stessa rotta di prima, e compare scansionando una tessera
vergine.

Da questa scelta discende una conseguenza che vale la pena avere in mente: da
quando il nome lo scrive il cliente, e' **testo che arriva da fuori** e che i
due pannelli mostrano a schermo. Per questo li' i nomi passano da una
funzione di escape prima di finire nella pagina - senza, un nome scritto
apposta potrebbe eseguire codice dentro un pannello gia' sbloccato.

### Tessera smarrita

Il cliente si presenta senza cartoncino e senza tessera nel telefono. Nel
pannello cassa c'e' un riquadro apposta: si cerca il suo numero (o il nome) e
compare il **QR da fargli inquadrare dallo schermo della cassa**, che lo porta
alla sua pagina e da li' al Wallet.

Il QR non si ricostruisce a mano da un indirizzo: chi sta al banco non deve
comporre link. E sta dietro la sessione di cassa, perche' porta al saldo di
una persona.

Se allo stesso numero corrispondono piu' tessere - una famiglia - si sceglie
da un elenco invece di indovinare: mostrare il QR sbagliato significa mostrare
a un cliente i punti di un altro.

Il prezzo di questa scelta: attivare non richiede piu' una cassa sbloccata,
quindi **chiunque abbia il codice di una tessera vergine puo' intestarsela**.
Regge per tre ragioni messe insieme: i codici non si indovinano (28 caratteri
per 8 posizioni), i cartoncini stanno nella scatola finche' non si consegnano,
e una tessera intestata a vanvera nasce comunque con zero punti e il titolare
puo' bloccarla. Quel che NON puo' succedere e' riscrivere il nome di un
cliente gia' registrato: una tessera si intesta una volta sola.

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

Serve **Node 21 o superiore** (i test usano i glob di `node --test`) e un
account Cloudflare gratuito.

```bash
npm install
npx wrangler login    # solo la prima volta su una macchina nuova
npm run db:local      # schema + premio iniziale, in locale
npm run dev           # http://127.0.0.1:8787
```

Al primo avvio il pannello chiede di scegliere il PIN del negozio.

```bash
npm test           # punti, codici, autenticazione, pass
npm run typecheck
```

> `db:local` applica le quattro migrazioni in fila ed e' pensato per un
> database **nuovo**: la `0002` inserisce il premio e la `0003` aggiunge una
> colonna, quindi rilanciarlo su un database gia' popolato duplica il premio e
> fallisce sull'`ALTER TABLE`. Per ripartire pulito basta cancellare
> `.wrangler/`.

## Messa in produzione

```bash
npx wrangler d1 create tessere        # copia l'id in wrangler.jsonc
npm run db:remote                     # le quattro migrazioni sul database vero
npx wrangler deploy
```

Vale lo stesso avvertimento di sopra: `db:remote` serve **una volta sola**, alla
creazione del database. Una migrazione successiva si applica da sola:

```bash
npx wrangler d1 execute tessere --remote --file=./migrations/0005_nuova.sql
```

> Il database di produzione esiste da prima della `0004`: quella va applicata
> **da sola**, con il comando qui sopra, e non rilanciando `db:remote`.

```bash
npx wrangler d1 execute tessere --remote --file=./migrations/0004_apple_wallet.sql
```

I segreti da impostare sono due, uno per Wallet, e ognuno ha il suo script
dedicato (vedi *La tessera nel telefono*):

```bash
npm run wallet:chiave -- "percorso/del/service-account.json"
npm run apple:certificato -- --chiave pass.key --certificato pass.cer
```

Non ce ne sono altri: il PIN vive come hash in `settings`, l'id del database
sta in `wrangler.jsonc`, l'ID emittente Google si incolla dal pannello
titolare, e Pass Type ID e Team ID di Apple stanno gia' dentro il certificato.

## Parametri

Si cambiano in `settings` senza rideploy:

| Chiave | Default | Cosa fa |
|---|---|---|
| `store_name` | `Pasticceria` | nome mostrato ovunque |
| `max_points_per_tx` | `20` | tetto anti-errore: il 2 che diventa 22 |
| `void_window_min` | `30` | minuti entro cui annullare un movimento |
| `show_rewards_to_customer` | `1` | `0` lascia al cliente il solo saldo punti |

`apple_auth_key` sta nella stessa tabella ma **non si tocca**: e' la chiave da
cui si derivano i token dei pass gia' consegnati. Cambiarla li scollegherebbe
tutti. Per questo non compare fra le chiavi modificabili dal pannello e non
esce nemmeno dalla API delle impostazioni.

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
  visibile al cliente, il cambio del PIN di cassa, e lo stato dei due Wallet.
  Quello di Apple ha tre stati e non due: attivo col push, attivo senza (il
  cliente vede i punti nuovi solo tirando giu' il pass), o non configurato.

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

### Apple Wallet - dinamico, a pagamento, tutto da firmare

Fino all'acquisto dell'account sviluppatore qui non c'era codice: da iOS 27
chiunque puo' creare un pass da solo, ma la funzione e' **avviata solo
dall'utente sul telefono**, e il pass resta congelato al momento in cui viene
creato. Quelle istruzioni restano sulla pagina cliente come ripiego, e
compaiono solo finche' il certificato non e' configurato.

Con l'account, il pass diventa un file che **firmiamo noi**, e si aggiorna da
solo come quello di Google. I due sistemi restano pero' asimmetrici nel modo
in cui aggiornano, e conviene saperlo:

| | Google | Apple |
|---|---|---|
| Dove sta il pass | sui server di Google | nel telefono |
| Aggiornare vuol dire | riscrivere l'oggetto da Google | svegliare il telefono, che riscarica |
| Se il servizio e' giu' | il saldo resta indietro | il saldo resta indietro |
| Si prova in locale | no, serve il dominio vero | il pass si', la notifica no |

**Un `.pkpass` e' uno ZIP** con dentro `pass.json`, le immagini, un manifesto
con l'impronta di ogni file, e la firma CMS del manifesto. Serve saperli
produrre entrambi dentro un Worker, dove non esistono ne' `zip` ne' `openssl`:
da qui `src/zip.ts` e `src/pkcs7.ts`.

La firma e' scritta a mano, come gia' il JWT di Google. Le librerie PKCS#7 per
JavaScript sono grosse, generiche e pensate per Node, e qui serve un caso solo
su tre algoritmi fissi. Il prezzo di questa scelta lo pagano i test: **una
firma sbagliata iOS la rifiuta senza dire una parola**, quindi i test non
guardano la forma, fanno verificare la firma a OpenSSL.

> Se un giorno quel test cominciasse a fallire, guarda il comando prima del
> codice: `openssl cms -verify` **senza `-binary`** riscrive gli a capo del
> contenuto prima di confrontarlo, e una firma giusta risulta sbagliata.

### Quel che non si puo' piu' cambiare

Un pass sa aggiornarsi solo se contiene `webServiceURL` e
`authenticationToken` **dal momento in cui viene creato**. Non sono
aggiungibili dopo: i pass gia' nei telefoni resterebbero congelati per sempre
e andrebbero rifatti uno per uno dai clienti.

Per la stessa ragione il prefisso delle rotte (`/wallet-apple`) e' scolpito
dentro ogni pass emesso: cambiarlo scollegherebbe tutti quelli gia' consegnati.

Il token di autenticazione si deriva da `apple_auth_key`, che sta in
`settings`, e **non dal certificato**. I certificati Apple scadono dopo un
anno: legarli avrebbe significato che al primo rinnovo tutti i pass gia'
consegnati avrebbero smesso di aggiornarsi, e ce ne saremmo accorti dal
reclamo di un cliente.

### Un segreto di Worker si ferma a 5,1 kB

Ci siamo sbattuti contro: certificato, chiave privata, chiave del push e
intermedio Apple, impacchettati come faceva il primo tentativo, fanno **8 kB** e
Cloudflare li rifiuta.

Due sprechi, tolti tutti e due:

- **la doppia codifica.** Un PEM *e' gia'* base64. Ricodificare in base64 il
  JSON che lo contiene lo gonfia di un terzo senza guadagnare niente, perche'
  qui i pezzi viaggiano senza intestazioni e senza a capo: non c'e' piu' niente
  che una variabile d'ambiente possa rovinare. Il segreto e' JSON semplice.
- **l'intermedio Apple.** E' un certificato **pubblico**, scaricabile da
  chiunque: non ha motivo di occupare lo spazio riservato ai segreti. Sta in
  `src/apple-wwdr.ts`, e il segreto puo' comunque portarne uno suo (`--wwdr`)
  che ha la precedenza, per il giorno in cui Apple cambiera' intermedio.

Risultato: **4 kB**, con un kilobyte di margine. Lo script misura il pacchetto
e si ferma prima di provarci, invece di far sbagliare Cloudflare.

### Il push funziona solo in produzione

Lo dice Apple, e si aggiunge una seconda ragione tecnica: APNs parla **solo
HTTP/2**, e il runtime locale dei Worker non lo fa. Sulla rete Cloudflare
invece si', quindi `wrangler dev` non e' il posto dove diagnosticare una
notifica che non arriva.

L'autenticazione ad APNs e' **a token (`.p8`) e non a certificato**. Non e' un
dettaglio di gusto: quella a certificato richiede una connessione TLS con
certificato cliente, che dentro un Worker si fa solo con il binding mTLS di
Cloudflare. Col token basta una `fetch` normale.

Come per Google, il fallimento e' silenzioso: la cassa non si ferma perche'
Apple non risponde. Nel peggiore dei casi il pass resta indietro finche' il
cliente non lo tira giu' a mano dal telefono.

### I passi per configurare Apple

Il giro dei certificati Apple si documenta ovunque partendo dal Portachiavi di
un Mac. Da Windows si fa tutto con OpenSSL, che Git Bash ha gia' dentro.

**1. La chiave e la richiesta di firma**, da dentro la cartella del progetto:

```bash
openssl genrsa -out pass.key 2048
MSYS2_ARG_CONV_EXCL="*" openssl req -new -key pass.key -out pass.csr -subj "/emailAddress=TUA@EMAIL/CN=Tessere/C=IT"
```

> `MSYS2_ARG_CONV_EXCL="*"` non e' superstizione: senza, Git Bash scambia
> `/emailAddress=...` per un percorso di Windows e lo riscrive, e OpenSSL
> fallisce con un errore che non c'entra niente.

`pass.key` e' la chiave privata. Non finisce nel repository (il `.gitignore`
esclude `*.key`) ma **va conservata**: senza, il certificato che Apple ti
restituisce non vale niente e il giro va rifatto.

**2. Il certificato**, su developer.apple.com: *Certificates, Identifiers &
Profiles* -> *Identifiers* -> **Pass Type IDs** -> crea un identificativo
(`pass.` seguito da un nome tuo, per esempio `pass.it.pasticceria.tessere`),
poi carica `pass.csr` e riscarica il certificato come `pass.cer`.

**3. La chiave per le notifiche** (facoltativa, ma senza non c'e' il push):
*Keys* -> nuova chiave con **Apple Push Notifications service (APNs)**
abilitato. Si scarica **una volta sola**, come `AuthKey_XXXXXXXXXX.p8`.

**4. Il caricamento:**

```bash
npm run apple:certificato -- --chiave pass.key --certificato pass.cer --apns AuthKey_XXXXXXXXXX.p8
```

Lo script controlla prima di caricare: che la chiave corrisponda davvero a quel
certificato, che sia un Pass Type ID e non un altro certificato Apple, e che
non sia gia' scaduto. Pass Type ID e Team ID non si chiedono perche' stanno
scritti dentro il certificato, e leggerli da li' toglie di mezzo l'unico modo
di farli discordare.

Non c'e' altro da incollare da nessuna parte: il pannello titolare dovrebbe
gia' dire *Attivo*.

### Se Google non risponde

L'aggiornamento del pass parte in sottofondo e ingoia ogni errore: la cassa non
deve fermarsi perche' Google e' giu'. Misurato con credenziali non valide, la
cassa risponde in **44 millisecondi** e i fallimenti restano nei log. Nel
peggiore dei casi il pass resta indietro finche' il cliente non riapre la sua
pagina.

### Le immagini: uno script, perche' i due Wallet le vogliono incompatibili

L'originale del logo sta in `assets/logo-golosone.png` e non viene mai servito:
tutto il resto si ricava da li'.

```bash
npm run grafica
```

Serve uno script perche' le misure non sono negoziabili e vanno in due
direzioni opposte:

| | Forma | Perche' |
|---|---|---|
| Google | quadrato, almeno 660x660, **sfondo pieno** | lo mostra su fondi di colore variabile: un PNG trasparente diventa illeggibile, e senza logo rifiuta proprio la classe (*"LoyaltyClass cannot be created without a program logo"*) |
| Apple, logo | **largo**, 160x50 punti | dargli un quadrato e' l'errore che fa sembrare la tessera vuota: iOS lo rimpicciolisce finche' entra in 50 punti d'altezza, e resta un francobollo in un angolo |
| Apple, icona | 29x29 punti | obbligatoria: senza, iPhone rifiuta il pass e non dice perche' |
| Apple, striscia | 375x123 punti | facoltativa: e' la fascia dietro il numero dei punti. Oggi **non se ne manda nessuna**, vedi qui sotto |

### Tre stili, e perche' non si puo' fare di meglio

Nel formato Apple il colore dei testi e' **uno solo per tutta la tessera**
(`foregroundColor`), e vale sia sopra la striscia sia sotto, sul fondo. Non
esiste quindi la fascia scura col numero chiaro e i campi scuri sul fondo
chiaro: o la tessera e' tutta chiara, o e' tutta scura. Da qui tre stili
interi invece di una manopola per la sola striscia.

```bash
npm run grafica -- --stile scuro
```

| Stile | Com'e' |
|---|---|
| `minimo` | **quello in uso**: fondo bianco caldo, testi bordeaux, nessuna striscia |
| `chiaro` | come sopra, ma con la fascia rosa cipria dal bordo smerlato |
| `scuro` | fondo bordeaux pieno, logo e testi in crema |

Lo stile predefinito e' quello del negozio: rilanciare lo script senza
argomenti riproduce quel che gira in produzione, non un altro stile che poi
finirebbe dentro i pass senza che nessuno se ne accorga.

Il Worker non sa nulla di stili: mette nel pacchetto le immagini che trova in
`public/pass/` e salta quelle che mancano. Passare da uno stile all'altro e'
quindi solo una questione di quali file esistono - tranne i colori dei testi,
che vanno riportati a mano in `src/apple-wallet.ts`. Lo script li stampa a
fine esecuzione, pronti da incollare.

Ogni immagine Apple esce in tre densita' (1x, 2x, 3x) e finisce in
`public/pass/` **gia' con il nome che Apple si aspetta**, cosi' il Worker la
copia dentro il pacchetto senza rinominare niente.

I colori non sono scelti a gusto: l'inchiostro e' il prugna misurato sui pixel
pieni del logo, `#56343c`. Lo stesso colore vive in tre posti, e cambiarne uno
solo si vede:

| Dove | Cosa colora |
|---|---|
| `public/tema.css` | il sito: cassa, pannello titolare, pagina cliente |
| `src/apple-wallet.ts` | i testi della tessera in Apple Wallet |
| `scripts/genera-grafica.mjs` | la striscia, quando lo stile ne prevede una |

Nel tema del sito ogni coppia testo/fondo e' verificata per contrasto (4,5:1
per il testo, 3:1 per le barre del grafico). La pagina cliente si apre al sole
davanti al banco, sullo schermo di chiunque: non e' pignoleria.

Il colore dei **dati** nel grafico resta separato da quello del marchio, ed e'
l'unico che non segue l'accento: il prugna ha croma troppo bassa e come barra
leggerebbe grigio.

Il logo di Google cambia solo alla creazione della classe. Se lo sostituisci
dopo, la classe esistente va aggiornata a mano dalla console Google: il
riallineamento automatico tocca nome e logo, ma non i colori.

## Riprendere il lavoro su un altro computer

Il codice si porta dietro con un `clone`; la conversazione con Claude Code, no.

```bash
git clone https://github.com/OLIX-boop/golosone-tessere.git
cd golosone-tessere
npm install
npx wrangler login
npm run db:local
npm run dev
```

Il database locale non viaggia col repository (`.wrangler/` e' escluso): quello
nuovo nasce vuoto, col premio iniziale e senza tessere. Il database di
produzione resta uno solo, su Cloudflare, e i due non si parlano.

### La sessione di Claude Code

Claude Code tiene la cronologia di ogni progetto in un file sul disco, non nel
repository:

```
~/.claude/projects/<percorso-del-progetto-con-i-trattini>/<id-sessione>.jsonl
```

Il nome della cartella e' il percorso del progetto con separatori e due punti
sostituiti da trattini. Qui, con il progetto in `C:\Users\andre\Desktop\golosone-tessere`:

```
C:\Users\andre\.claude\projects\C--Users-andre-Desktop-golosone-tessere\
```

Per continuare la stessa conversazione altrove:

1. copia quel file `.jsonl` sul secondo computer, nella cartella corrispondente
   al percorso in cui hai messo il progetto **li'** (se l'utente Windows si
   chiama diversamente, cambia anche il nome della cartella: la codifica deve
   combaciare con il percorso reale, altrimenti Claude Code non trova nulla);
2. apri il progetto e lancia `claude --resume`, poi scegli la sessione
   dall'elenco.

**Quel file non va su GitHub.** Contiene per intero i comandi eseguiti e il loro
output, quindi anche le chiavi incollate durante il lavoro — nel nostro caso la
chiave privata del service account Google. Il `.gitignore` esclude i `.jsonl`
apposta: si trasferisce a mano, con una chiavetta o una cartella cloud privata.

## Da fare

- [ ] Ristampa di un lotto, marcando le tessere sostituite
- [ ] Chiedere a Google l'accesso alla pubblicazione (finche' l'emittente e'
      in modalita' demo, i pass funzionano solo per gli account di prova)
- [ ] Provare il pass Apple su un iPhone vero, dopo il deploy: e' l'unica cosa
      che i test non possono verificare da fermi
- [ ] Segnare in calendario la scadenza del certificato Apple, **19 ottobre
      2027**: quando scade il pulsante smette di funzionare, e va rifatto il
      giro del portale. I pass gia' nei telefoni continuano ad aggiornarsi,
      perche' i loro token non dipendono dal certificato

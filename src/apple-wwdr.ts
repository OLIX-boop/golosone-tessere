/**
 * Intermedio Apple WWDR G4.
 *
 * NON e' un segreto: e' il certificato pubblico con cui Apple firma i
 * certificati degli sviluppatori, e chiunque puo' scaricarlo da
 * https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer
 *
 * Sta nel codice per una ragione pratica: un segreto di Worker non puo'
 * superare i 5,1 kB, e certificato, chiave privata, chiave del push e questo
 * intermedio insieme ne fanno circa 5,6. Togliere di mezzo l'unico pezzo che
 * non ha niente da nascondere fa stare tutto il resto sotto il limite, e in
 * piu' risparmia allo script di caricamento una richiesta di rete.
 *
 * Serve perche' la firma del pass deve portarsi dietro la catena: senza
 * l'intermedio, iPhone non riesce a risalire dal certificato del negozio a
 * una radice di cui si fida, e rifiuta il pass.
 *
 * Scade il 10 dicembre 2030. Se un giorno Apple passasse a un intermedio
 * nuovo non serve toccare questo file: basta passare --wwdr allo script di
 * caricamento, e quello nel segreto avra' la precedenza.
 */
export const WWDR_G4 = `
MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQELBQAwYjEL
MAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRp
ZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBSb290IENBMB4XDTIwMTIxNjE5
MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UEAww7QXBwbGUgV29ybGR3aWRlIERldmVs
b3BlciBSZWxhdGlvbnMgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMw
EQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBANAfeKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOP
R8SGHgjov9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41t
QSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB5kaP5eYq
+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVlPNkuYmQzHWxq3Y4h
qqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64DYyEMe9QbsWLFApy9/a8CAwEA
AaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm
90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUu
Y29tL29jc3AwMy1hcHBsZXJvb3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFw
cGxlLmNvbS9yb290LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0P
AQH/BAQDAgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbD
eeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWvp50h5wES
A5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPefx4elUWY0GzlxOSTj
h2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJEtHlgepZAE9bPFo22noicwkJ
ac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQA1iZQT0xWmJArzmoUUOSqwSonMJNsUvS
q3xKX+udO7xPiEAGE/+QF4oIRynoYpgppU8RBWk6z/Kf
`;

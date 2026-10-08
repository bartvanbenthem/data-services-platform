# Toegang tot buckets en configuratie-opties

Dit document beschrijft hoe een applicatie toegang krijgt tot een COSI bucket en welke configuratie opties er zijn. Wat over het gedrag van de Cloudian driver staat, is afgeleid uit de manifests, `lib.sh` en de verify-stap in `deploy-cosi-buckets.sh`.

## Hoe toegang werkt

Er zijn twee lagen: de bucket zelf (`BucketClass` + `BucketClaim`) en de toegang tot die bucket (`BucketAccessClass` + `BucketAccess`).

```
BucketAccessClass (cluster-breed)       BucketClaim (namespace)
  driverName, authenticationType              │
            │                                 │
            └──────────► BucketAccess ◄───────┘
                         (namespace, zelfde als claim)
                              │
                     sidecar → DriverGrantBucketAccess → Cloudian
                              │
                              ▼
                  Secret <credentialsSecretName>
                    key: BucketInfo  (één JSON-blob)
```

1. Er wordt een `BucketAccess` aangemaakt ([manifests/bucketaccess.yaml](manifests/bucketaccess.yaml)). Die verwijst naar een `BucketClaim` en een `BucketAccessClass`, en geeft de naam op van het Secret dat moet worden aangemaakt.
2. De sidecar ziet het object en roept `DriverGrantBucketAccess` aan op de Cloudian-driver.
3. De driver maakt in HyperStore een identiteit aan met rechten op alleen die ene bucket, en een access key/secret key voor die identiteit.
4. De sidecar schrijft het resultaat naar het Secret. Daarna staat `status.accessGranted: true` op de `BucketAccess`.
5. Bij het verwijderen van de `BucketAccess` wordt `DriverRevokeBucketAccess` aangeroepen en worden de credentials ingetrokken.

### Inhoud van het Secret

Het Secret heeft geen losse keys zoals `AWS_ACCESS_KEY_ID`, maar één key `BucketInfo` met JSON erin (zie `extract_bucket_info` in [deploy-cosi-buckets.sh](deploy-cosi-buckets.sh)):

```json
{ "spec": {
    "bucketName": "cosi-test-bucketclass<uid>",
    "secretS3": { "endpoint": "...", "region": "...",
                  "accessKeyID": "...", "accessSecretKey": "..." } } }
```

Een applicatie kan dus niet simpelweg `envFrom: secretRef` gebruiken. Mogelijkheden:

- Het Secret als volume mounten en `BucketInfo` in de app parsen. Veel COSI-aware libraries doen dit al.
- Een init-container het JSON laten omzetten naar env-vars of een AWS-configbestand.
- Een operator of script de losse velden in een eigen Secret laten zetten.

### Aandachtspunten

- **De bucketnaam is niet zelf te kiezen.** De COSI-controller maakt hem aan als `<BucketClassName><claim-UID>`. De app moet de naam uit `BucketInfo` lezen.
- **Namespace-grens.** `BucketAccess`, `BucketClaim`, `ServiceAccount` en het Secret moeten in dezelfde namespace staan. Toegang vanuit een andere namespace kan in v1alpha1 niet.
- **Meerdere `BucketAccess`-objecten per claim kan wel.** Elk krijgt een eigen set credentials, bijvoorbeeld één per app. Dan is toegang ook per app in te trekken.
- **De `serviceAccountName` doet in deze setup waarschijnlijk niets.** In de COSI-spec is `IAM` bedoeld voor workload identity: de pod gebruikt zijn ServiceAccount-token en er komen geen keys in het Secret. De Cloudian-driver geeft in IAM-modus toch statische keys terug, want de verify-stap gebruikt ze. Het ServiceAccount dat het script aanmaakt speelt bij het inloggen dus waarschijnlijk geen rol. *(Aanname, niet geverifieerd tegen de driverbroncode.)*
- **Onderscheid tussen read-only en read-write** zit niet in de v1alpha1-spec. Onbekend is of de Cloudian-driver daarvoor `parameters` op de `BucketAccessClass` ondersteunt.

## Configuratie-opties

### 1. Authenticatie: `AUTH_TYPE` (op de `BucketAccessClass`)

| | `IAM` (standaard, aanbevolen) | `KEY` |
|---|---|---|
| Hoe | De driver maakt met de eigen S3/IAM-credentials een IAM-user aan met een policy die alleen die bucket toelaat, plus access keys | De driver maakt via de HyperStore Admin API een HyperStore-user aan in een group |
| Driver heeft nodig | `s3.iamEndpoint`, `s3.accessKey`/`secretAccessKey` | Ook het `admin`-blok: `endpoint`, `username`, `password`, `group` |
| Waar de buckets komen | In het account van de driver-credentials | In de opgegeven group |

**Let op:** [manifests/helm-values.yaml](manifests/helm-values.yaml) vult het `admin`-blok nu niet in. Met alleen `AUTH_TYPE=KEY` wordt de mode op de `BucketAccessClass` gezet, maar heeft de driver geen admin-credentials en zal de grant falen. Voor KEY-mode moet het `admin`-blok worden toegevoegd aan de values en aan `COSI_TEMPLATE_VARS` in [lib.sh](lib.sh).

### 2. Driver (Helm-values, [deploy-cosi-crds-driver.sh](deploy-cosi-crds-driver.sh))

| Optie | Doel |
|---|---|
| `s3.s3Endpoint` / `s3.iamEndpoint` / `s3.region` | HyperStore-endpoints. Die komen in het `BucketInfo`-Secret terecht, dus apps moeten ze kunnen bereiken |
| `s3.accessKey` / `secretAccessKey` | De identiteit waarmee de driver buckets en users aanmaakt. Dit is het krachtigste credential in de hele keten |
| `existingCredentialsSecret` | Verwijst naar een bestaand Secret in plaats van de keys via Helm-values mee te geven. Beter voor productie, want dan staan de keys niet in de Helm-release |
| `existingS3CertificateSecret` | Een eigen CA mounten voor de driver, voor endpoints met een private CA |
| `disableTLSCertificateCheck` | Alleen voor self-signed. De KPN-endpoints valideren tegen de system store |
| `admin.*` | Alleen voor KEY-mode, zie hierboven |

### 3. Buckets (`BucketClass`, [manifests/bucketclass.yaml](manifests/bucketclass.yaml))

- **`deletionPolicy`**: `Delete` (nu ingesteld) verwijdert de S3-bucket als de claim wordt verwijderd. `Retain` laat de bucket en de data staan. Voor alles buiten een test is `Retain` meestal de veiligere keuze.
- **`parameters`**: een vrije map die naar de driver gaat. Welke keys Cloudian ondersteunt, is niet gedocumenteerd in deze repo.

### 4. Script-variabelen

| Variabele | Standaard | Opmerking |
|---|---|---|
| `NAMESPACE` | `zs3-cosi-test` | Waar de claims, accesses, SA's en Secrets komen |
| `AUTH_TYPE` | `IAM` | Zie §1 |
| `BUCKET_NAME_PREFIX` | `cosi-test` | Maximaal **15 tekens**, want `<prefix>-bucketclass` mag niet langer zijn dan 27 (zie `check_bucket_class_name_length`) |
| `BUCKET_NAMES` | `"1 2"` | Eén claim, access, SA en Secret per suffix |
| `DISABLE_TLS_CERT_CHECK` | `false` | Geldt zowel voor de driver als voor de `aws` CLI in de verify-stap |
| `RELEASE_NAME` | `cloudian-cosi-driver` | Naam van de driver-deployment |
| `AWS_CA_BUNDLE` | system store | Alleen voor de lokale verify, niet voor de cluster |

Voorbeeld:

```bash
BUCKET_NAME_PREFIX=app BUCKET_NAMES="logs backups" ./deploy-cosi-buckets.sh install
```

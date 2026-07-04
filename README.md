# mObywatel Serwer 🇵🇱

## Struktura folderów

```
twoj-folder/
  server.js          ← serwer (ten plik)
  package.json       ← konfiguracja Node.js
  render.yaml        ← konfiguracja Render
  Dockerfile         ← opcjonalnie (nie wymagane na Render)
  software/          ← Twoje pliki HTML/CSS/JS (wrzuć całą zawartość ZIPa tutaj)
    assets/
    card.html
    dashboard.html
    generator.html
    ... itd
  data/              ← tworzy się automatycznie, tu jest baza SQLite
    app.db
```

---

## Deploy na Render — krok po kroku

### 1. Wejdź do folderu projektu
- `cd c:\Users\uzytkownik\Downloads\softwarenajs-main\softwarenajs-main`

### 2. Wrzuć projekt na GitHub
- Render najwygodniej deployuje bezpośrednio z repo.

### 3. Utwórz usługę na Render
- Wejdź na [https://render.com](https://render.com)
- New + → **Web Service** → wybierz repozytorium

### 4. Ustawienia serwisu
- Build Command: `npm install`
- Start Command: `npm start`
- Region: dowolny (najlepiej najbliższy)

### 5. Persistent Disk (wymagane dla SQLite)
- W Render dodaj **Disk**
- Mount Path: `/var/data`
- Size: np. `1 GB`
- To jest kluczowe, inaczej dane mogą zniknąć po restarcie/relokacji.

### 6. Zmienne środowiskowe (opcjonalnie, ale zalecane)
- `ADMIN_LOGIN` = np. `admin`
- `ADMIN_PASSWORD` = mocne hasło
- `DATA_DIR` = `/var/data` (w `render.yaml` już ustawione)

### 7. Deploy
- Kliknij **Create Web Service** i poczekaj na build.

---

## Jak używać

### Logowanie do panelu
1. Wejdź na `https://<twoja-apka>.onrender.com/login`
2. Wpisz login i hasło admina (domyślnie: `admin` / `admin123`, chyba że ustawisz env)
3. Kliknij "Zaloguj się"

### Tworzenie nowego dowodu
1. W panelu kliknij "Utwórz"
2. Wpisz wszystkie dane osoby
3. Wgraj zdjęcie
4. Kliknij "Zapisz"
5. W panelu kliknij "Skopiuj URL" przy nowym dowodzie
6. Wyślij ten link osobie — gotowe! ✅

### Link dla odbiorcy wygląda tak:
```
https://<twoja-apka>.onrender.com/id?card_token=UNIKALNY_TOKEN
```

Każda osoba ma swój unikalny token — link działa zawsze. 🔥

---

## Problemy?

**Serwer nie startuje** → Sprawdź czy folder `software/` jest na miejscu

**Dane znikają po restarcie** → Upewnij się, że na Render jest podpięty Persistent Disk na `/var/data`

**Zdjęcie nie ładuje** → Upewnij się że wgrałeś zdjęcie podczas tworzenia dowodu

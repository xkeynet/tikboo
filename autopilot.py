import os
import sys
import json
import re

def clean_filename(text):
    # Vyčistí text od zakázaných znaků, aby byl použitelný v URL
    text = re.sub(r'[^\w\s\.-]', '', text)
    return text.replace(' ', '%20')

def process_pipeline(video_url, folder, custom_title):
    # Pokud jsi nezadal název, vygenerujeme univerzální podle času
    if not custom_title or custom_title.strip() == "":
        import time
        custom_title = f"Video_{int(time.time())}"
        
    print(f"--- Zpracování odkazu pro název: {custom_title} ---")
    
    # Vytvoření čistého názvu souboru, přesně jak to prošlo u dreamfall.art
    safe_title = clean_filename(custom_title)
    
    # Vygenerování finální R2 URL adresy, kterou tvůj web očekává
    # Pokud video nahraješ na Cloudflare manuálně pod stejným názvem, web ho okamžitě přehraje
    final_cdn_url = f"https://pub-dcf634f0c29b4449bae68897ac703aff.r2.dev/videos/{folder}/{safe_title}.mp4"
    
    db_path = "db.json"
    db_data = []
    
    if os.path.exists(db_path):
        try:
            with open(db_path, "r", encoding="utf-8") as f:
                db_data = json.load(f)
        except Exception:
            db_data = []

    # Struktura dat, která ti předtím perfektně fungovala pro zobrazení na webu
    new_entry = {
        "id": safe_title.replace('%20', '_'),
        "source_url": video_url,
        "video_url": final_cdn_url,
        "folder": folder,
        "title": custom_title,
        "type": "native_r2"
    }
    
    # Odstranění duplicity a vložení na první místo feedu
    db_data = [item for item in db_data if item.get("title") != custom_title]
    db_data.insert(0, new_entry)

    with open(db_path, "w", encoding="utf-8") as f:
        json.dump(db_data, f, indent=2, ensure_ascii=False)
        
    print(f"🎯 Úspěšně zapsáno! Video '{custom_title}' je v db.json.")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Chyba: Nedostatek parametrů.")
        sys.exit(1)
        
    url_arg = sys.argv[1]
    folder_arg = sys.argv[2]
    title_arg = sys.argv[3] if len(sys.argv) > 3 else ""
    
    process_pipeline(url_arg, folder_arg, title_arg)

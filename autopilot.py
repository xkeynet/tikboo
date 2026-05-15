import sys
import json
import os

def get_universal_embed(url, folder):
    """
    Vezme jakoukoli URL a připraví z ní data pro embed přehrávač.
    """
    # Vyčistíme URL od zbytečností na konci
    clean_url = url.split('?')[0].rstrip('/')
    
    # Vygenerujeme ID jednoduše z URL (poslední část adresy)
    # Funguje to pro 99 % stránek jako identifikátor
    video_id = clean_url.split('/')[-1]
    
    # UNIVERZÁLNÍ LOGIKA:
    # Většina pornostránek má embed linky ve formátu /embed/ID nebo /embedframe/ID
    # Tady definujeme, jak se chovat k nejčastějším webům, zbytek vyřešíme univerzálně
    
    embed_url = url # Základní fallback
    
    if "xnxx.com" in url:
        # Příklad: xnxx.com/video-123/název -> xnxx.com/embedframe/123
        match = clean_url.split('video-')
        if len(match) > 1:
            id_only = match[1].split('/')[0]
            embed_url = f"https://www.xnxx.com/embedframe/{id_only}"
            
    elif "pornhub.com" in url:
        # Příklad: pornhub.com/view_video.php?viewkey=ph123 -> pornhub.com/embed/ph123
        if "viewkey=" in url:
            id_only = url.split("viewkey=")[1].split("&")[0]
            embed_url = f"https://www.pornhub.com/embed/{id_only}"

    elif "xhamster.com" in url:
        # Příklad: xhamster.com/videos/video-123 -> xhamster.com/embed/video-123
        id_only = clean_url.split('/')[-1]
        embed_url = f"https://xhamster.com/embed/{id_only}"

    # DATA PRO TVŮJ JSON (Databázi)
    video_data = {
        "id": video_id,
        "source_url": url,       # Původní adresa
        "embed_url": embed_url,   # Adresa pro tvůj swipe přehrávač
        "folder": folder,         # Tvoje kategorie (např. 'adult')
        "title": f"Video {video_id}",
        "added_at": os.environ.get('GITHUB_RUN_ID', 'manual') # Kdy to bylo přidáno
    }

    print(json.dumps(video_data, indent=2))
    return video_data

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        get_universal_embed(sys.argv[1], sys.argv[2])

from pathlib import Path
import uvicorn
from backend.app import create_app

ROOT = Path(__file__).parent.resolve()
app = create_app(ROOT)

if __name__ == "__main__":
    print("myBookLM Local running on http://127.0.0.1:8765")
    uvicorn.run("app:app", host="127.0.0.1", port=8765, reload=False)

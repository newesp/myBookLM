from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from . import db, routes


def create_app(root: Path) -> FastAPI:
    books_dir = root / "books"
    skills_dir = root / "skills"
    data_dir = root / "data"
    frontend_dir = root / "frontend"
    config_path = data_dir / "config.json"
    db_path = data_dir / "app.db"

    for d in (books_dir, skills_dir, data_dir):
        d.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.init_db(db_path)
        # Any job left in "running" state from a previous process crash → flip to paused.
        with db.conn() as c:
            c.execute("UPDATE jobs SET status='paused' WHERE status='running'")
            c.commit()
        yield

    app = FastAPI(title="myBookLM Local", lifespan=lifespan)

    app.state.root = root
    app.state.books_dir = books_dir
    app.state.skills_dir = skills_dir
    app.state.data_dir = data_dir
    app.state.config_path = config_path
    app.state.db_path = db_path

    app.include_router(routes.router, prefix="/api")
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

    @app.get("/")
    async def index():
        return FileResponse(frontend_dir / "index.html")

    return app

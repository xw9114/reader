"""Deliver committed platform state while another writer advances main."""
import os
from pathlib import Path
import subprocess


def sync(repo, attempts=3, command=None):
    repo=Path(repo)
    def run(args):
        result=subprocess.run(args,cwd=repo,text=True,capture_output=True,timeout=120,
                              env=dict(os.environ,GIT_TERMINAL_PROMPT='0'))
        if result.returncode:
            raise RuntimeError(f'{args[0:3]}: {result.stderr[-1400:]}')
        return result.stdout.strip()
    run=command or run
    if run(['git','status','--porcelain']):
        raise RuntimeError('Uncommitted publisher changes preserved; commit them before synchronization')
    for attempt in range(attempts):
        run(['git','fetch','origin','main'])
        run(['git','rebase','origin/main'])
        try:
            run(['git','push','origin','HEAD:main'])
            return run(['git','rev-parse','HEAD'])
        except RuntimeError:
            if attempt+1==attempts:
                raise
    raise RuntimeError('No synchronization attempts configured')


if __name__=='__main__':
    print('GIT_SYNC_OK',sync(Path(__file__).resolve().parents[1]))

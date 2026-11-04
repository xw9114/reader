import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('sync_git',Path(__file__).resolve().parents[1]/'automation/sync_git.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(repo,*args):
    r=subprocess.run(['git',*args],cwd=repo,text=True,capture_output=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


class SynchronizationTests(unittest.TestCase):
    def test_concurrent_writer_after_fetch_is_rebased_without_republishing(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            origin=root/'origin.git'
            git(root,'init','--bare','--initial-branch=main',str(origin))
            publisher=root/'publisher'
            writer=root/'writer'
            git(root,'clone',str(origin),str(publisher))
            for key,value in [('user.name','Isolated Test'),('user.email','test@localhost')]:
                git(publisher,'config',key,value)
            (publisher/'seed').write_text('seed')
            git(publisher,'add','seed')
            git(publisher,'commit','-m','seed')
            git(publisher,'push','origin','main')
            git(root,'clone',str(origin),str(writer))
            for key,value in [('user.name','Isolated Test'),('user.email','test@localhost')]:
                git(writer,'config',key,value)
            (publisher/'ledger.json').write_text('published state')
            git(publisher,'add','ledger.json')
            git(publisher,'commit','-m','platform evidence')
            interrupted=[False]
            def run(args):
                if args[:2]==['git','push'] and not interrupted[0]:
                    interrupted[0]=True
                    (writer/'chapter.md').write_text('concurrent source')
                    git(writer,'add','chapter.md')
                    git(writer,'commit','-m','concurrent manuscript')
                    git(writer,'push','origin','main')
                return git(publisher,*args[1:])
            delivered=module.sync(publisher,command=run)
            self.assertEqual(git(origin,'rev-parse','main'),delivered)
            self.assertEqual((publisher/'chapter.md').read_text(),'concurrent source')
            self.assertEqual((publisher/'ledger.json').read_text(),'published state')
            self.assertEqual(git(origin,'rev-list','--count','main'),'3')
            (publisher/'ledger.json').write_text('uncommitted state')
            with self.assertRaisesRegex(RuntimeError,'Uncommitted'):
                module.sync(publisher)
            self.assertEqual((publisher/'ledger.json').read_text(),'uncommitted state')

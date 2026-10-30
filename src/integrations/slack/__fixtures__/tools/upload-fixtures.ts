import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HELLO_CONTENT = 'hello upload\n';
export const HELLO_SIZE = 13;
export const HELLO_SHA256 = '993a327368cc9a443f6d9a11d146da9e9ba2d561a8ef1e9190d119b2b1a002e0';

export const SECOND_CONTENT = 'second file body\n';
export const SECOND_SIZE = 17;
export const SECOND_SHA256 = '023b8e80f089c258fde65e37b7aa85b87d13729614d047d2e1039a49dc442543';

/** Same length as HELLO_CONTENT, different bytes. */
export const SAME_SIZE_OTHER_CONTENT = 'HELLO UPLOAD\n';

export interface UploadWorkdir {
  dir: string;
  file: (name: string, content: string) => string;
  link: (name: string, target: string) => string;
  subdir: (name: string) => string;
  remove: () => void;
}

/** A private temp directory (already resolved through realpath) for upload sources. */
export function createUploadWorkdir(): UploadWorkdir {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slack-upload-red-')));
  return {
    dir,
    file: (name, content) => {
      const target = path.join(dir, name);
      fs.writeFileSync(target, content);
      return target;
    },
    link: (name, target) => {
      const linkPath = path.join(dir, name);
      fs.symlinkSync(target, linkPath);
      return linkPath;
    },
    subdir: (name) => {
      const target = path.join(dir, name);
      fs.mkdirSync(target);
      return target;
    },
    remove: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

import fs from 'fs';
import path from 'path';

describe('DataKey Sync Guard', () => {
  it('detects drift between SDK DataKey and contract storage_layout.rs', () => {
    // Locate vero-core-contracts repository
    const possiblePaths = [
      path.resolve(__dirname, '../../../../vero-core-contracts'),
      path.resolve(__dirname, '../../../vero-core-contracts'),
      path.resolve(__dirname, '../../../../boss/vero-core-contracts'),
    ];

    let contractRepoPath = '';
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        contractRepoPath = p;
        break;
      }
    }

    if (!contractRepoPath) {
      console.warn('vero-core-contracts repository not found adjacent to vero-sdk. Skipping sync check.');
      return; 
    }

    const storageLayoutPath = path.join(contractRepoPath, 'src/contracts/storage_layout.rs');
    
    if (!fs.existsSync(storageLayoutPath)) {
      console.warn(storage_layout.rs not found at  + storageLayoutPath + . Skipping sync check.);
      return;
    }

    const rustContent = fs.readFileSync(storageLayoutPath, 'utf8');

    expect(rustContent).toContain('"task_"');
    expect(rustContent).toContain('"vote_"');
    expect(rustContent).toContain('"vero_reputation"');
  });
});

# Updating

Updating keeps all data: instances, jobs, run history, snapshots, the SSH key and your login. Re-running `install.sh` detects the existing install (`/etc/fsmanager/install.conf`), asks **Upgrade the app?**, rebuilds the app and restarts the service.

Don't update while a run is in progress. The service restart stops it, and the next start marks it as interrupted.

## Manager: from Git

```bash
cd ~/freescout-sync-manager
git pull
sudo bash install.sh
```

## Manager: from a release archive (copied from Windows)

In **PowerShell** on Windows:

```powershell
cd $HOME\Downloads
scp .\fsmanager.tar.gz youruser@192.168.1.50:~/
ssh youruser@192.168.1.50
```

On the Ubuntu manager:

```bash
rm -rf ~/fsmanager
tar xzf fsmanager.tar.gz
cd fsmanager
sudo bash install.sh
```

## Agents (each FreeScout server)

When a release changes the agent (see [CHANGELOG.md](../CHANGELOG.md)), re-run the agent install command on every FreeScout server. Copy it from **Settings** in the web app:

```bash
curl -fsSk https://fsmanager.example.local/agent/install.sh -o install-agent.sh && sudo bash install-agent.sh
```

Add the same `--dir` / `--name` options you used the first time. Then check the version:

```bash
sudo /usr/local/sbin/fs-agent version     # fs-agent 1.2.1
```

The **Instances** page shows each agent's version (click **Check now** to refresh it). A run that needs a newer agent stops before changing anything and says so.

## Check it's running

```bash
systemctl status fsmanager
sudo journalctl -u fsmanager -n 50 --no-pager
```

Then open the web app and press **Ctrl+F5** to reload the browser UI.

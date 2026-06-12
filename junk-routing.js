// Resolve the junk folder for a message group by its source folder's account.
// Account names are only a legacy fallback because they are not unique.
export async function junkFolderForGroup(group, accounts, junkFolderByAccountId, getFolder) {
  let accountId = null;
  if (group.folderId) {
    try {
      accountId = (await getFolder(group.folderId)).accountId;
    } catch (e) {
      // Folder may no longer exist; fall back below.
    }
  }
  if (!accountId) accountId = accounts.find(account => account.name === group.accountName)?.id || null;
  return accountId ? junkFolderByAccountId[accountId] : null;
}

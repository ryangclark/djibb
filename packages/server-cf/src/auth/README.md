### Accounts

A user may have multiple accounts. An account has:

-   an authentication method
    -   currently only Email/Password
-   display name
-   email address(es)
-   image URL for avatar/profile pic

### Entering the site

A user enters the site by authenticating into either their account or their workspace.

#### Authenticating by account

A user arrives at the site. They click the "sign in" button and enter their email and password.

After successful authentication, we pull all accounts tied to that email via `GetAccountsByEmail(email)`, then pull all workspaces for each account by calling `GetWorkspacesByAccount(account_id)`.

That allows us to show the user a list of their accounts, and the workspaces for each, so they can select a workspace and get working.

#### Authenticating by workspace

I don't know how this would work exactly. The idea here is taken from Slack, which allows you to log into a workspace (e.g. `use-weave.slack.com`).

The main reason this feels important is because a user may have previously authenticated using multiple auth methods, and the email/password for one account/workspace doesn't grant them access to their desired workspace (e.g. a friend's workspace they've been invited into via old email address).

**Problem:** I don't know how to facilitate a user finding the correct credentials to log into a workspace...

### On permissions

I like how Clerk does permissions. They're just strings, with colons
separate "units" or "levels".

-   `org:member` denotes the account has the member role
-   `org:admin` denotes the account has admin role
-   `org:billing` denotes the account has the billing role (custom role)
-   `org:items:read` denotes the account has a permission to read items, though not to "write" or "update" them.
-   `org:<resource>:<action>` - pattern for custom permissions.

#### Thinking out loud – authing list-access

Accessing a list via `GET` request:

-   If request has a session cookie:
    -   Use Session's active Account ID for the List ID
        -   This is a map of `map[ListID]AccountID` with a `_default` key, too
        -   Need methods to update those values
    -   Session has no active Account ID for list
        -   Need method to set the Account ID on the Session
        -   Check the User DO for last used Account ID for the List
            -   This is a map of `map[ListID]AccountID`
            -   Need method to update that map whenever the user selects an Account ID for the List
    -   List has a map of `map[UserID]AccountID` to track the last
-   If no session cookie

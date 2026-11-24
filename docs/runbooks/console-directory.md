# Console collaborator directory

The knowledge collaborator manager reads display metadata from the internal
`GET /api/console/directory` endpoint. The endpoint requires a console session
with `knowledge:manage` or workspace ownership and never adds a canonical
OpenAPI operation.

Set `KB_CONSOLE_DIRECTORY_FILE` to a JSON file with this shape:

```json
{
  "members": [
    {
      "memberId": "mem_owner",
      "name": "林知远",
      "departmentIds": ["engineering"],
      "groupIds": ["owners"]
    }
  ],
  "departments": [{ "id": "engineering", "name": "研发部", "parentId": null }],
  "groups": [{ "id": "owners", "name": "管理组", "parentId": null }]
}
```

`avatarUrl` is optional. When no file is configured, mock auth derives member
IDs from `KB_MOCK_MEMBER_IDS`; departments and groups are empty. Member grants
continue to use the collaborator API, while department and group grants map to
the existing ACL `org` and `group` principal types.

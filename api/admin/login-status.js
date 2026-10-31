{
    "path": "api/admin/login-status.js",
    "text": "import { adminSetupStatus, hasAdminSession } from \"../../lib/admin-auth.js\";\nexport const access = \"public\";\nexport const methods = [\"GET\"];\nexport default async function(req,res) {\n  try {\n    const configured = await adminSetupStatus();\n    if (!configured) return res.json({ configured:false, authenticated:false });\n    const authenticated = await hasAdminSession(req);\n    return res.json({ configured:true, authenticated:Boolean(authenticated) });\n  } catch (e) { return res.status(500).json({ error:\"admin_status_failed\" }); }\n}",
    "hash": "a69bfc9b5441abdce3a116b79b7827ec6bda23b9c11432226ed4968dc0524080",
    "total_lines": 11
}
import { db, storage } from "hatchable";
import { requireNetworkUser } from "../../lib/network-auth.js";

export const access="public";
export const methods=["GET"];

export default async function(req,res){
  const user=await requireNetworkUser(req,res);
  if(!user)return;
  const p=await db.query("SELECT role,deleted_at,login_blocked FROM app_profiles WHERE id=$1",[user.id]);
  if(!p.rows.length||p.rows[0].role!=="marketer"||p.rows[0].deleted_at||p.rows[0].login_blocked)return res.status(403).json({error:"marketer_only"});
  const cats=await db.query("SELECT id,name,slug FROM store_categories WHERE active=true ORDER BY created_at ASC");
  const products=await db.query(`SELECT p.id,p.name,p.slug,p.description,p.price,p.stock,p.bv,p.category_id,c.name AS category_name
    FROM products p LEFT JOIN store_categories c ON c.id=p.category_id
    WHERE p.active=true ORDER BY p.created_at DESC`);
  const images=await db.query("SELECT id,product_id,storage_key,sort_order FROM product_images WHERE product_id = ANY($1::uuid[]) ORDER BY sort_order ASC,created_at ASC",[products.rows.map(x=>x.id)]);
  const imageRows=await Promise.all(images.rows.map(async x=>({...x,url:await storage.url(x.storage_key)})));
  const byProduct=new Map(); for(const x of imageRows){if(!byProduct.has(x.product_id))byProduct.set(x.product_id,[]);byProduct.get(x.product_id).push(x)}
  for(const p of products.rows)p.images=byProduct.get(p.id)||[];
  res.json({categories:cats.rows,products:products.rows});
}
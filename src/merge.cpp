/***
Copyright (c) 2016 Big Fish Games

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
***/
#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include "merge.h"

using json = nlohmann::json;

static constexpr int NO_CONFLICT  = 0;
static constexpr int HAS_CONFLICT = 1;

// ══════════════════════════════════════════════════════════════════════════
// Low-level helpers
// ══════════════════════════════════════════════════════════════════════════

// True when v is a sole-key {__id__: ...} reference object.
static bool isIdRef(const json& v) {
	return v.is_object() && v.size() == 1 && v.count("__id__");
}

// Recursively collect all UUID string values found in {__id__: "uuid"} refs.
static void collectUUIDRefs(const json& v, std::vector<std::string>& out) {
	if (!v.is_object() && !v.is_array()) return;
	if (v.is_array()) {
		for (const auto& e : v) collectUUIDRefs(e, out);
		return;
	}
	if (isIdRef(v) && v["__id__"].is_string()) {
		out.push_back(v["__id__"].get<std::string>());
		return;
	}
	for (auto it = v.begin(); it != v.end(); ++it) collectUUIDRefs(it.value(), out);
}

// In-place: replace {__id__: N} → {__id__: "uuid"} using i2id.
static void applyUUID(json& v, const std::unordered_map<int, std::string>& i2id) {
	if (v.is_array()) {
		for (auto& e : v) applyUUID(e, i2id);
		return;
	}
	if (!v.is_object()) return;
	if (isIdRef(v) && v["__id__"].is_number_integer()) {
		int idx = v["__id__"].get<int>();
		auto it = i2id.find(idx);
		v["__id__"] = (it != i2id.end()) ? it->second : ("@idx:" + std::to_string(idx));
		return;
	}
	for (auto it = v.begin(); it != v.end(); ++it) applyUUID(it.value(), i2id);
}

// In-place: replace {__id__: "uuid"} → {__id__: N} using uuid2idx.
static void applyIndex(json& v, const std::unordered_map<std::string, int>& uuid2idx, int& dangling) {
	if (v.is_array()) {
		for (auto& e : v) applyIndex(e, uuid2idx, dangling);
		return;
	}
	if (!v.is_object()) return;
	if (isIdRef(v) && v["__id__"].is_string()) {
		auto it = uuid2idx.find(v["__id__"].get<std::string>());
		if (it != uuid2idx.end()) {
			v["__id__"] = it->second;
		} else {
			v["__id__"] = -1;
			++dangling;
		}
		return;
	}
	for (auto it = v.begin(); it != v.end(); ++it) applyIndex(it.value(), uuid2idx, dangling);
}

// ══════════════════════════════════════════════════════════════════════════
// Reference-array three-way set merge
//
// Arrays whose elements are {__id__: "uuid"} refs are merged with set semantics:
//   - Item present in mine: keep unless base had it AND theirs deleted it.
//   - Item only in theirs (not base): theirs added it, append.
// Order: mine's surviving items first, then theirs-only additions.
// ══════════════════════════════════════════════════════════════════════════

static const std::unordered_set<std::string> REF_ARRAY_FIELDS = {
	"_children", "_components", "_clips",
	"clickEvents", "propertyOverrides",
	"mountedChildren", "mountedComponents", "removedComponents",
	"targetOverrides",
};

static json mergeRefArray(const json& base, const json& mine, const json& theirs) {
	auto getIDs = [](const json& arr) {
		std::unordered_set<std::string> s;
		for (const auto& r : arr)
			if (r.is_object() && r.count("__id__") && r["__id__"].is_string())
				s.insert(r["__id__"].get<std::string>());
		return s;
	};
	auto bS = getIDs(base), mS = getIDs(mine), tS = getIDs(theirs);

	json result = json::array();
	std::unordered_set<std::string> seen;

	for (const auto& r : mine) {
		if (!r.is_object() || !r.count("__id__") || !r["__id__"].is_string()) continue;
		std::string id = r["__id__"].get<std::string>();
		if (seen.count(id)) continue;
		seen.insert(id);
		if (!bS.count(id) || tS.count(id)) result.push_back(r);  // mine added, or both kept
	}
	for (const auto& r : theirs) {
		if (!r.is_object() || !r.count("__id__") || !r["__id__"].is_string()) continue;
		std::string id = r["__id__"].get<std::string>();
		if (seen.count(id)) continue;
		if (!bS.count(id) && !mS.count(id)) { seen.insert(id); result.push_back(r); }  // theirs added
	}
	return result;
}

// ══════════════════════════════════════════════════════════════════════════
// Property-level three-way merge of a single object
// ══════════════════════════════════════════════════════════════════════════

struct Conflict {
	std::string id;
	std::string key;
	json mine;
	json theirs;
};

static json mergeObject(
	const std::string& id,
	const json& base,
	const json& mine,
	const json& theirs,
	std::vector<Conflict>& conflicts
) {
	json result = json::object();
	std::unordered_set<std::string> keys;
	for (auto it = mine.begin(); it != mine.end(); ++it) keys.insert(it.key());
	for (auto it = theirs.begin(); it != theirs.end(); ++it) keys.insert(it.key());

	const json emptyVal;

	for (const auto& k : keys) {
		json bv = base.count(k) ? base[k] : emptyVal;
		json mv = mine.count(k) ? mine[k] : emptyVal;
		json tv = theirs.count(k) ? theirs[k] : emptyVal;
		bool mc = (mv != bv), tc = (tv != bv);

		if (REF_ARRAY_FIELDS.count(k)) {
			result[k] = mergeRefArray(
				bv.is_array() ? bv : json::array(),
				mv.is_array() ? mv : json::array(),
				tv.is_array() ? tv : json::array());
		} else if (!mc && !tc) {
			result[k] = bv.is_null() ? mv : bv;       // both unchanged
		} else if (mc && !tc) {
			result[k] = mv;                             // only mine changed
		} else if (!mc && tc) {
			result[k] = tv;                             // only theirs changed
		} else if (mv == tv) {
			result[k] = mv;                             // both changed to same value
		} else {
			result[k] = mv;                             // real conflict: keep mine, flag it
			conflicts.push_back({id, k, mv, tv});
		}
	}
	return result;
}

// ══════════════════════════════════════════════════════════════════════════
// FileRevision — stable ID assignment
//
// Pass order (processes objects that haven't been assigned an ID yet):
//  1. Non-empty _id field             CC1.x/CC2.4/CC3.8 scene nodes & components
//  2. cc.PrefabInfo / CompPrefabInfo  CC2.4 prefab nodes, CC3.8 prefab components
//  3. CC1.x/CC2.4 derived component   node/scene/root/... field + __type__
//  4. cc.PrefabInstance.fileId        CC3.8 nested prefab instances
//  5. cc.TargetInfo.localID           CC3.8 override target path
//  6. CCPropertyOverrideInfo          targetInfo localID + propertyPath
//  7. cc.TargetOverrideInfo           source stable ID + propertyPath
//  8. Stub target/source nodes        bare {__type__,__editorExtras__} nodes in TargetOverrideInfo
//  9. Singletons by __type__          objects that appear exactly once
// 10. Fallback: __type__[index]       anything still unresolved
// ══════════════════════════════════════════════════════════════════════════

void FileRevision::buildIDMap() {
	int n = static_cast<int>(jsonObject.size());

	auto reg = [&](int idx, std::string id) {
		i2id[idx] = id;
		id2i[id] = idx;
	};

	// ── Pass 1: non-empty _id ────────────────────────────────────────────
	for (int i = 0; i < n; ++i) {
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("_id") || !o["_id"].is_string()) continue;
		std::string id = o["_id"].get<std::string>();
		if (!id.empty()) reg(i, id);
	}

	// ── Pass 2: cc.PrefabInfo / cc.CompPrefabInfo → owner ───────────────
	for (int i = 0; i < n; ++i) {
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		std::string t = o["__type__"].get<std::string>();
		if (t != "cc.PrefabInfo" && t != "cc.CompPrefabInfo") continue;
		if (!o.count("fileId") || !o["fileId"].is_string()) continue;
		std::string fid = o["fileId"].get<std::string>();
		if (fid.empty()) continue;  // root node's PrefabInfo has fileId: ""

		for (int j = 0; j < n; ++j) {
			if (i2id.count(j)) continue;
			const auto& owner = jsonObject[j];
			if (!owner.is_object()) continue;
			auto isRef = [&](const char* field) {
				if (!owner.count(field)) return false;
				const auto& ref = owner[field];
				return ref.is_object() && ref.count("__id__") &&
				       ref["__id__"].is_number_integer() && ref["__id__"].get<int>() == i;
			};
			if (isRef("_prefab") || isRef("__prefab")) {
				reg(j, fid);
				reg(i, "pi:" + fid);
				break;
			}
		}
	}

	// ── Pass 3: CC1.x / CC2.4 components derived from node-ref + __type__ ─
	// Types that have their own dedicated passes must be excluded here.
	static const std::unordered_set<std::string> skipDerived = {
		"cc.PrefabInfo", "cc.CompPrefabInfo", "cc.PrefabInstance",
		"cc.TargetInfo", "CCPropertyOverrideInfo", "cc.TargetOverrideInfo",
		"cc.ClickEvent",
	};
	static const char* nodeRefFields[] = {
		"node", "scene", "root", "target", "data", "customDataOverride", nullptr
	};
	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		std::string type = o["__type__"].get<std::string>();
		if (skipDerived.count(type)) continue;

		for (int k = 0; nodeRefFields[k]; ++k) {
			const char* field = nodeRefFields[k];
			if (!o.count(field)) continue;
			const auto& ref = o[field];
			if (!ref.is_object() || !ref.count("__id__") || !ref["__id__"].is_number_integer()) continue;
			auto it = i2id.find(ref["__id__"].get<int>());
			if (it == i2id.end()) continue;
			reg(i, it->second + type);
			break;
		}
	}

	// ── Pass 4: cc.PrefabInstance.fileId ─────────────────────────────────
	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		if (o["__type__"].get<std::string>() != "cc.PrefabInstance") continue;
		if (!o.count("fileId") || !o["fileId"].is_string()) continue;
		std::string fid = o["fileId"].get<std::string>();
		if (!fid.empty()) reg(i, "inst:" + fid);
	}

	// ── Pass 5: cc.TargetInfo by localID ─────────────────────────────────
	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		if (o["__type__"].get<std::string>() != "cc.TargetInfo") continue;
		if (!o.count("localID") || !o["localID"].is_array() || o["localID"].empty()) continue;
		std::string id = "ti:";
		for (size_t k = 0; k < o["localID"].size(); ++k) {
			if (k) id += '|';
			id += o["localID"][k].get<std::string>();
		}
		reg(i, id);
	}

	// ── Pass 6: CCPropertyOverrideInfo by targetInfo localID + propertyPath ─
	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		if (o["__type__"].get<std::string>() != "CCPropertyOverrideInfo") continue;
		if (!o.count("targetInfo") || !o["targetInfo"].is_object()) continue;
		if (!o["targetInfo"].count("__id__") || !o["targetInfo"]["__id__"].is_number_integer()) continue;
		auto tiIt = i2id.find(o["targetInfo"]["__id__"].get<int>());
		if (tiIt == i2id.end()) continue;
		if (!o.count("propertyPath") || !o["propertyPath"].is_array()) continue;
		std::string id = "po:" + tiIt->second + ":";
		for (size_t k = 0; k < o["propertyPath"].size(); ++k) {
			if (k) id += '.';
			id += o["propertyPath"][k].get<std::string>();
		}
		reg(i, id);
	}

	// ── Pass 7: cc.TargetOverrideInfo by source stable ID + propertyPath ──
	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		if (o["__type__"].get<std::string>() != "cc.TargetOverrideInfo") continue;
		if (!o.count("source") || !o["source"].is_object()) continue;
		if (!o["source"].count("__id__") || !o["source"]["__id__"].is_number_integer()) continue;
		auto srcIt = i2id.find(o["source"]["__id__"].get<int>());
		if (srcIt == i2id.end()) continue;
		if (!o.count("propertyPath") || !o["propertyPath"].is_array()) continue;
		std::string id = "to:" + srcIt->second + ":";
		for (size_t k = 0; k < o["propertyPath"].size(); ++k) {
			if (k) id += '.';
			id += o["propertyPath"][k].get<std::string>();
		}
		reg(i, id);
	}

	// ── Pass 8: stub target/source nodes inside cc.TargetOverrideInfo ─────
	// Bare {__type__, __editorExtras__} nodes that act as reference anchors
	// have no _id or _prefab; they get a stable ID derived from their owner.
	for (int i = 0; i < n; ++i) {
		if (!i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		if (o["__type__"].get<std::string>() != "cc.TargetOverrideInfo") continue;
		const std::string& toID = i2id.at(i);

		auto tryStub = [&](const char* field, const char* prefix) {
			if (!o.count(field) || !o[field].is_object()) return;
			if (!o[field].count("__id__") || !o[field]["__id__"].is_number_integer()) return;
			int idx = o[field]["__id__"].get<int>();
			if (!i2id.count(idx)) reg(idx, std::string(prefix) + toID);
		};
		tryStub("target", "target_of:");
		tryStub("source", "source_of:");
	}

	// ── Pass 8b: cc.ClickEvent by target node stable ID + _componentId + handler ─
	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		if (o["__type__"].get<std::string>() != "cc.ClickEvent") continue;
		if (!o.count("target") || !o["target"].is_object()) continue;
		if (!o["target"].count("__id__") || !o["target"]["__id__"].is_number_integer()) continue;
		auto tIt = i2id.find(o["target"]["__id__"].get<int>());
		if (tIt == i2id.end()) continue;
		if (!o.count("_componentId") || !o["_componentId"].is_string()) continue;
		if (!o.count("handler") || !o["handler"].is_string()) continue;
		std::string cid = o["_componentId"].get<std::string>();
		std::string handler = o["handler"].get<std::string>();
		if (!cid.empty() && !handler.empty()) reg(i, "click:" + tIt->second + ":" + cid + ":" + handler);
	}

	// ── Pass 9: singletons by __type__ ───────────────────────────────────
	std::unordered_map<std::string, int> typeCounts;
	for (const auto& o : jsonObject)
		if (o.is_object() && o.count("__type__"))
			typeCounts[o["__type__"].get<std::string>()]++;

	for (int i = 0; i < n; ++i) {
		if (i2id.count(i)) continue;
		const auto& o = jsonObject[i];
		if (!o.is_object() || !o.count("__type__")) continue;
		std::string type = o["__type__"].get<std::string>();
		std::string id = (typeCounts[type] == 1)
			? ("singleton:" + type)
			: (type + "[" + std::to_string(i) + "]");
		reg(i, id);
	}
}

void FileRevision::convertToUUID() {
	for (auto& obj : jsonObject) applyUUID(obj, i2id);
}

FileRevision::FileRevision(const std::string& fileName) {
	jsonObject = readJSON(fileName);
	buildIDMap();
	convertToUUID();
}

// ══════════════════════════════════════════════════════════════════════════
// I/O
// ══════════════════════════════════════════════════════════════════════════

json readJSON(const std::string& fileName) {
	std::cout << "Reading " << fileName << std::endl;
	std::ifstream f(fileName);
	std::stringstream buf;
	buf << f.rdbuf();
	return json::parse(buf.str());
}

void writeJSON(const std::string& content, const std::string& fileName) {
	std::ofstream out(fileName);
	out << content;
}

// ══════════════════════════════════════════════════════════════════════════
// Three-way merge
// ══════════════════════════════════════════════════════════════════════════

static int doMerge(
	const FileRevision& base,
	const FileRevision& mine,
	const FileRevision& theirs,
	const std::string& outPath
) {
	// Build UUID → object pointer maps (objects are already UUID-ified by the constructor)
	std::unordered_map<std::string, const json*> baseBy, mineBy, theirsBy;
	for (const auto& p : base.i2id)
		if (p.first < (int)base.jsonObject.size()) baseBy[p.second]   = &base.jsonObject[p.first];
	for (const auto& p : mine.i2id)
		if (p.first < (int)mine.jsonObject.size()) mineBy[p.second]   = &mine.jsonObject[p.first];
	for (const auto& p : theirs.i2id)
		if (p.first < (int)theirs.jsonObject.size()) theirsBy[p.second] = &theirs.jsonObject[p.first];

	// Collect all unique stable IDs
	std::unordered_set<std::string> allIDs;
	for (const auto& p : baseBy)   allIDs.insert(p.first);
	for (const auto& p : mineBy)   allIDs.insert(p.first);
	for (const auto& p : theirsBy) allIDs.insert(p.first);

	// ── Object-level three-way merge ──────────────────────────────────────
	std::unordered_map<std::string, json> result;  // id → merged object (UUID form)
	std::vector<Conflict> conflicts;

	int added_mine = 0, added_theirs = 0, merged = 0, deleted = 0, conflict_delete = 0;

	const json emptyObj = json::object();

	for (const auto& id : allIDs) {
		bool inB = baseBy.count(id), inM = mineBy.count(id), inT = theirsBy.count(id);

		if (inM && inT) {
			const json& bObj = inB ? *baseBy.at(id) : emptyObj;
			result[id] = mergeObject(id, bObj, *mineBy.at(id), *theirsBy.at(id), conflicts);
			++merged;
		} else if (inM) {
			if (!inB) {
				result[id] = *mineBy.at(id);   // mine added
				++added_mine;
			} else if (*mineBy.at(id) != *baseBy.at(id)) {
				// theirs deleted, but mine modified → conflict: keep mine
				conflicts.push_back({id, "__deleted_by_theirs__", *mineBy.at(id), {}});
				result[id] = *mineBy.at(id);
				++conflict_delete;
			} else {
				++deleted;                      // theirs deleted, mine unchanged → accept
			}
		} else if (inT) {
			if (!inB) {
				result[id] = *theirsBy.at(id);  // theirs added
				++added_theirs;
			} else if (*theirsBy.at(id) != *baseBy.at(id)) {
				// mine deleted, but theirs modified → conflict: keep theirs
				conflicts.push_back({id, "__deleted_by_mine__", {}, *theirsBy.at(id)});
				result[id] = *theirsBy.at(id);
				++conflict_delete;
			} else {
				++deleted;                      // mine deleted, theirs unchanged → accept
			}
		}
		// in base only (both deleted) → omit
	}

	// ── Cascade: pull in objects referenced by survivors but not yet included ─
	// This handles e.g. CCPropertyOverrideInfo → cc.TargetInfo where the TargetInfo
	// was deleted by one branch but the override survived.
	int cascade = 0;
	bool changed = true;
	while (changed) {
		changed = false;
		std::vector<std::string> toAdd;
		for (const auto& entry : result) {
			std::vector<std::string> refs;
			collectUUIDRefs(entry.second, refs);
			for (const auto& refID : refs) {
				if (result.count(refID)) continue;
				const json* pulled = nullptr;
				if (mineBy.count(refID))        pulled = mineBy.at(refID);
				else if (theirsBy.count(refID)) pulled = theirsBy.at(refID);
				else if (baseBy.count(refID))   pulled = baseBy.at(refID);
				if (pulled) { result[refID] = *pulled; toAdd.push_back(refID); changed = true; }
			}
		}
		cascade += static_cast<int>(toAdd.size());
	}

	// ── Build output array: mine's original order, then theirs-only additions ─
	std::vector<std::string> outputIDs;
	std::unordered_set<std::string> seen;

	for (int i = 0; i < (int)mine.jsonObject.size(); ++i) {
		auto it = mine.i2id.find(i);
		if (it == mine.i2id.end()) continue;
		if (result.count(it->second) && !seen.count(it->second)) {
			outputIDs.push_back(it->second);
			seen.insert(it->second);
		}
	}
	for (int i = 0; i < (int)theirs.jsonObject.size(); ++i) {
		auto it = theirs.i2id.find(i);
		if (it == theirs.i2id.end()) continue;
		if (result.count(it->second) && !seen.count(it->second)) {
			outputIDs.push_back(it->second);
			seen.insert(it->second);
		}
	}
	for (const auto& entry : result) {  // stragglers (cascade-added, etc.)
		if (!seen.count(entry.first)) { outputIDs.push_back(entry.first); seen.insert(entry.first); }
	}

	// ── Convert UUID refs back to integer indices ─────────────────────────
	std::unordered_map<std::string, int> uuid2idx;
	for (int i = 0; i < (int)outputIDs.size(); ++i) uuid2idx[outputIDs[i]] = i;

	json output = json::array();
	int dangling = 0;
	for (const auto& id : outputIDs) {
		json obj = result.at(id);
		applyIndex(obj, uuid2idx, dangling);
		output.push_back(std::move(obj));
	}

	// ── Report ────────────────────────────────────────────────────────────
	int contentConflicts = 0;
	for (const auto& c : conflicts) {
		if (c.key.size() < 2 || c.key[0] != '_' || c.key[1] != '_') ++contentConflicts;
	}

	std::cout << "Output: " << output.size() << " objects -> " << outPath << std::endl;
	std::cout << "Stats:  added_mine=" << added_mine
	          << "  added_theirs=" << added_theirs
	          << "  merged=" << merged
	          << "  deleted=" << deleted
	          << "  cascade=" << cascade << std::endl;

	if (dangling > 0)
		std::cerr << "WARNING: " << dangling << " dangling __id__ refs in output" << std::endl;

	if (contentConflicts > 0) {
		std::cerr << "CONFLICTS (" << contentConflicts << "):" << std::endl;
		for (const auto& c : conflicts) {
			if (c.key.size() >= 2 && c.key[0] == '_' && c.key[1] == '_') continue;
			std::cerr << "  " << c.key << "  id=" << c.id << std::endl;
			std::cerr << "    MINE:   " << c.mine.dump().substr(0, 120) << std::endl;
			std::cerr << "    THEIRS: " << c.theirs.dump().substr(0, 120) << std::endl;
		}
	}
	if (conflict_delete > 0)
		std::cerr << "DELETE CONFLICTS: " << conflict_delete << " (one side deleted, other modified)" << std::endl;

	writeJSON(output.dump(2), outPath);
	return (contentConflicts > 0 || conflict_delete > 0) ? HAS_CONFLICT : NO_CONFLICT;
}

// ══════════════════════════════════════════════════════════════════════════
// Entry point
// git invokes: firemerge <mine> <base> <theirs> [output]
// Writes merged result to <output> (defaults to <mine> if omitted).
// Returns 0 on clean merge, 1 if any conflicts remain.
// ══════════════════════════════════════════════════════════════════════════

int main(int argc, char** argv) {
	std::cout << "FireMerge" << std::endl;

	if (argc < 4) {
		std::cerr << "Usage: firemerge <mine> <base> <theirs> [output]" << std::endl;
		return 1;
	}

	std::string minePath   = argv[1];
	std::string basePath   = argv[2];
	std::string theirsPath = argv[3];
	std::string outPath    = (argc >= 5) ? argv[4] : argv[1];

	FileRevision mine(minePath);
	FileRevision base(basePath);
	FileRevision theirs(theirsPath);

	return doMerge(base, mine, theirs, outPath);
}

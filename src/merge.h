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
#pragma once
#include <unordered_map>
#include <string>
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#pragma clang diagnostic ignored "-Wdeprecated-literal-operator"
#include "json.hpp"
#pragma clang diagnostic pop

// Represents one revision of a scene/prefab file.
// Constructor loads the file, assigns stable string IDs to every array entry,
// then converts all {__id__: N} integer refs to {__id__: "uuid"} strings in-place.
class FileRevision {
public:
	FileRevision(const std::string& fileName);
	FileRevision() = default;

	// Assign a stable string ID to every object in jsonObject.
	// Handles CC1.x, CC2.4 and CC3.8 scene and prefab formats.
	void buildIDMap();

	// In-place: replace every {__id__: N} integer ref with {__id__: "uuid"}.
	void convertToUUID();

	nlohmann::json jsonObject;
	std::unordered_map<int, std::string> i2id;  // array index → stable ID
	std::unordered_map<std::string, int> id2i;  // stable ID → array index
};

nlohmann::json readJSON(const std::string& fileName);
void writeJSON(const std::string& content, const std::string& fileName);
